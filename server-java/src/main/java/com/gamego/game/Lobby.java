package com.gamego.game;

import com.gamego.db.User;
import com.gamego.web.RateLimiter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.IntUnaryOperator;

/**
 * 大厅（移植自 Node 版 game/lobby.js）：把匹配队列、好友房与对局管理器串起来（设计文档 5.2 的 hello / match.* / room.* / ai.start）。
 * 所有推送经 {@link GamePush#send} 发出；在请求处理中产生的推送会排在 res 之后（见 ws.Hub 的 batch）。只在游戏循环线程上使用。
 */
public class Lobby {

  static final List<String> COLORS = List.of("black", "white", "random");

  private final GameManager manager;
  private final Matchmaker matchmaker;
  private final RoomRegistry rooms;
  private final GameStore store;
  private final GamePush hub;
  private final GameSettings settings;
  private final GameLog logger;
  private final IntUnaryOperator randomInt;
  /** 按用户限流（不随连接重置）：开人机对局的频率。 */
  final RateLimiter aiStartLimit;
  /** 找不到房间的次数（防止枚举 6 位房号）。 */
  final RateLimiter roomMissLimit;

  public Lobby(
      GameManager manager,
      Matchmaker matchmaker,
      RoomRegistry rooms,
      GameStore store,
      GamePush hub,
      GameSettings settings,
      GameLog logger,
      GameLoop loop,
      IntUnaryOperator randomInt) {
    this.manager = manager;
    this.matchmaker = matchmaker;
    this.rooms = rooms;
    this.store = store;
    this.hub = hub;
    this.settings = settings;
    this.logger = logger;
    this.randomInt = randomInt != null ? randomInt : Players.SECURE_RANDOM_INT;
    this.aiStartLimit = new RateLimiter(settings.aiStartBurst, 1000.0 / settings.aiStartRefillMs, loop::now);
    this.roomMissLimit = new RateLimiter(settings.roomMissBurst, 1000.0 / settings.roomMissRefillMs, loop::now);
  }

  /** 清掉已经补满的限流桶（由 realtime 定时调用）。 */
  public void prune() {
    aiStartLimit.prune();
    roomMissLimit.prune();
  }

  private void requireSize(Integer size) {
    if (size == null || !settings.sizes.contains(size)) throw new GameError("bad_request", "路数只能是 9、13 或 19");
  }

  private void requireColor(String color) {
    if (!COLORS.contains(color)) throw new GameError("bad_request", "执子只能是 black、white 或 random");
  }

  private void requireNotInGame(long userId) {
    if (manager.humanGameOf(userId) != null) throw new GameError("in_game", "你还有一局棋没下完");
  }

  private Map<String, Object> userInfo(long userId) {
    User user = null;
    try {
      user = store.findUser(userId);
    } catch (RuntimeException err) {
      logger.error("读取用户 " + userId + " 失败", err);
    }
    return Players.playerInfo(user, settings.publicBaseUrl, userId);
  }

  private Map<String, Object> roomView(RoomRegistry.Room room) {
    return rooms.view(room, userInfo(room.ownerId));
  }

  // ---------- hello ----------

  public Map<String, Object> hello(long userId) {
    RoomRegistry.Room room = rooms.ofOwner(userId);
    return Msg.of(
        "activeGames", manager.activeGamesOf(userId),
        "room", room != null ? roomView(room) : null,
        "matching", matchmaker.statusOf(userId));
  }

  // ---------- 快速匹配 ----------

  public Map<String, Object> matchJoin(long userId, int size) {
    requireSize(size);
    requireNotInGame(userId);
    closeRoomOf(userId);
    Matchmaker.JoinResult r = matchmaker.join(userId, size);
    if (r.pair() != null) startRanked(size, r.pair());
    return Msg.of("size", size);
  }

  private void startRanked(int size, long[] pair) {
    long first = pair[0];
    long second = pair[1];
    boolean firstBlack = randomInt.applyAsInt(2) == 0;
    long blackId = firstBlack ? first : second;
    long whiteId = firstBlack ? second : first;
    GameSession session;
    try {
      session = manager.createHumanGame("ranked", size, blackId, whiteId);
    } catch (RuntimeException err) {
      // 建局失败：先排队的人放回队首，后来的（当前请求者）收到 internal 错误
      matchmaker.requeueFront(first, size);
      throw err;
    }
    for (long uid : pair) hub.send(uid, Msg.of("t", "match.found", "gameId", session.id()));
  }

  public void matchCancel(long userId) {
    matchmaker.cancel(userId);
  }

  // ---------- 好友房 ----------

  public Map<String, Object> roomCreate(long userId, int size, String color) {
    requireSize(size);
    requireColor(color);
    requireNotInGame(userId);
    matchmaker.cancel(userId);
    RoomRegistry.Created c = rooms.create(userId, size, color);
    if (c.replaced() != null) notifyClosed(c.replaced(), List.of(userId));
    return Msg.of("room", roomView(c.room()));
  }

  /** 查房间：连续找不到房间太多次（猜房号）→ rate_limited，一段时间内所有房号都查不了。 */
  private RoomRegistry.Room findRoom(long userId, String code) {
    if (!roomMissLimit.allows(userId)) throw new GameError("rate_limited", "房号输错太多次，请稍后再试");
    RoomRegistry.Room room = rooms.get(code);
    if (room == null) {
      roomMissLimit.take(userId);
      throw new GameError("room_not_found", "房间不存在或已过期");
    }
    return room;
  }

  public Map<String, Object> roomGet(long userId, String code) {
    RoomRegistry.Room room = findRoom(userId, code);
    if (room.ownerId != userId) room.watchers.add(userId);
    return Msg.of("room", roomView(room));
  }

  /**
   * 房主不在线（切到后台等人）也可以加入：对局照常创建，房主到场前不走他的钟、不判弃局（见 GameSession.expectArrival），
   * 房主回来后 hello.activeGames 里就有这局。
   */
  public Map<String, Object> roomJoin(long userId, String code) {
    RoomRegistry.Room room = findRoom(userId, code);
    if (room.ownerId == userId) throw new GameError("own_room", "不能加入自己创建的房间");
    requireNotInGame(userId);
    if (manager.humanGameOf(room.ownerId) != null) {
      // 房主已在别的对局中（正常流程下不会发生）：房间作废
      rooms.remove(room.code);
      notifyClosed(room, List.of(room.ownerId));
      throw new GameError("room_not_found", "房间已关闭");
    }
    int ownerColor = "black".equals(room.color) ? 1 : "white".equals(room.color) ? 2 : randomInt.applyAsInt(2) + 1;
    long blackId = ownerColor == 1 ? room.ownerId : userId;
    long whiteId = ownerColor == 1 ? userId : room.ownerId;
    GameSession session = manager.createHumanGame("friend", room.size, blackId, whiteId);
    rooms.remove(room.code);
    notifyClosed(room, List.of(room.ownerId, userId));
    closeRoomOf(userId);
    matchmaker.cancel(room.ownerId);
    matchmaker.cancel(userId);
    for (long uid : new long[] {room.ownerId, userId}) {
      hub.send(uid, Msg.of("t", "game.start", "gameId", session.id(), "mode", "friend"));
    }
    return Msg.of("gameId", session.id());
  }

  public void roomLeave(long userId) {
    closeRoomOf(userId);
  }

  /** 关闭该用户创建的房间（房主自己发起，不通知房主）。 */
  private void closeRoomOf(long userId) {
    RoomRegistry.Room room = rooms.ofOwner(userId);
    if (room == null) return;
    rooms.remove(room.code);
    notifyClosed(room, List.of(userId));
  }

  /** 通知查看过房间的人：房间已关闭。 */
  private void notifyClosed(RoomRegistry.Room room, List<Long> exclude) {
    Map<String, Object> view = roomView(room);
    for (long uid : new ArrayList<>(room.watchers)) {
      if (!exclude.contains(uid)) hub.send(uid, Msg.of("t", "room.update", "room", view));
    }
  }

  /** 房间到期：通知房主与查看过的人。 */
  public void onRoomExpired(RoomRegistry.Room room) {
    Map<String, Object> view = roomView(room);
    Set<Long> targets = new LinkedHashSet<>();
    targets.add(room.ownerId);
    targets.addAll(room.watchers);
    for (long uid : targets) hub.send(uid, Msg.of("t", "room.update", "room", view));
  }

  // ---------- 人机 ----------

  /** 排位/好友对局进行中不能开人机（离开会按掉线判负）；开局有频率限制（每局都要写库、请求 AI）。 */
  public Map<String, Object> aiStart(long userId, int size, String level, String color) {
    requireSize(size);
    requireColor(color);
    if (level == null || level.isEmpty()) throw new GameError("bad_request", "缺少难度");
    requireNotInGame(userId);
    if (!aiStartLimit.take(userId)) throw new GameError("rate_limited", "开局太频繁，请稍后再试");
    GameSession session = manager.startAiGame(userId, size, level, color);
    return Msg.of("gameId", session.id());
  }

  // ---------- 连接 ----------

  public void userOffline(long userId) {
    matchmaker.cancel(userId);
  }

  /**
   * 同一用户的新连接顶替了旧连接：退出匹配队列。在匹配页上重连的会在 ready 后重新 match.join；
   * 换到别的设备则不会在不知情的情况下被配对。好友房保留（新连接的 hello.room 里能看到）。
   */
  public void userReplaced(long userId) {
    matchmaker.cancel(userId);
  }

  // ---------- 测试与排障 ----------

  public int aiStartLimitSize() {
    return aiStartLimit.size();
  }

  public int roomMissLimitSize() {
    return roomMissLimit.size();
  }
}
