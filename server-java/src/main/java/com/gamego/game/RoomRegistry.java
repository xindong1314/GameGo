package com.gamego.game;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.IntUnaryOperator;
import java.util.regex.Pattern;

/**
 * 好友房登记表（移植自 Node 版 game/rooms.js）：6 位数字房号（在等待中的房间里唯一）、有效期、每人最多一个房间。
 * 房主可以离线等待。房间只存在内存里，重启后失效。只在游戏循环线程上使用。
 */
public class RoomRegistry {

  static final long MAX_TIMER_MS = 2147483647L;
  public static final Pattern ROOM_CODE_RE = Pattern.compile("^\\d{6}$");

  /** 一个房间。 */
  public static final class Room {
    public final String code;
    public final long ownerId;
    public final int size;
    public final String color;
    String status = "waiting";
    public final long createdAt;
    public final long expiresAt;
    /** 查看过房间的受邀者，房间关闭时通知他们。 */
    public final Set<Long> watchers = new LinkedHashSet<>();
    GameLoop.Timer timer;

    Room(String code, long ownerId, int size, String color, long createdAt, long expiresAt) {
      this.code = code;
      this.ownerId = ownerId;
      this.size = size;
      this.color = color;
      this.createdAt = createdAt;
      this.expiresAt = expiresAt;
    }

    public String status() {
      return status;
    }
  }

  /** create 的结果：replaced 为被关闭的旧房间（没有为 null）。 */
  public record Created(Room room, Room replaced) {}

  private final long ttlMs;
  private final GameLoop loop;
  private final IntUnaryOperator randomInt;
  private final Consumer<Room> onExpire;
  private final GameLog logger;
  private final Map<String, Room> rooms = new LinkedHashMap<>();
  private final Map<Long, String> byOwner = new HashMap<>();

  /** onExpire(room)：房间过期时回调（此时已从登记表移除，status 为 closed）。 */
  public RoomRegistry(long ttlMs, GameLoop loop, IntUnaryOperator randomInt, Consumer<Room> onExpire, GameLog logger) {
    if (ttlMs <= 0) throw new IllegalArgumentException("RoomRegistry: ttlMs 必须是正整数");
    if (loop == null) throw new IllegalArgumentException("RoomRegistry: 需要 loop");
    this.ttlMs = ttlMs;
    this.loop = loop;
    this.randomInt = randomInt != null ? randomInt : Players.SECURE_RANDOM_INT;
    this.onExpire = onExpire != null ? onExpire : r -> {};
    this.logger = logger;
  }

  private String newCode() {
    for (int i = 0; i < 100; i++) {
      String code = String.format("%06d", randomInt.applyAsInt(1000000));
      if (!rooms.containsKey(code)) return code;
    }
    throw new IllegalStateException("无法生成空闲的房号");
  }

  /** 创建房间；该用户已有房间时先关闭旧的（旧房间通过返回值 replaced 交给调用方通知）。 */
  public Created create(long ownerId, int size, String color) {
    Room replaced = ofOwner(ownerId);
    if (replaced != null) remove(replaced.code);
    String code = newCode();
    long createdAt = loop.now();
    Room room = new Room(code, ownerId, size, color, createdAt, createdAt + ttlMs);
    rooms.put(code, room);
    byOwner.put(ownerId, code);
    arm(room);
    return new Created(room, replaced);
  }

  private void arm(Room room) {
    long delay = Math.min(Math.max(0, room.expiresAt - loop.now()), MAX_TIMER_MS);
    room.timer = loop.schedule(() -> {
      room.timer = null;
      expire(room.code);
    }, delay);
  }

  private void expire(String code) {
    Room room = rooms.get(code);
    if (room == null) return;
    if (loop.now() < room.expiresAt) {
      arm(room); // 定时器提前触发（或超过最大延时被截断）
      return;
    }
    remove(code);
    try {
      onExpire.accept(room);
    } catch (RuntimeException err) {
      if (logger != null) logger.error("房间过期通知失败", err);
    }
  }

  /** 等待中的房间；过期的顺便清掉。 */
  public Room get(String code) {
    if (code == null || !ROOM_CODE_RE.matcher(code).matches()) return null;
    Room room = rooms.get(code);
    if (room == null) return null;
    if (loop.now() >= room.expiresAt) {
      expire(code);
      return null;
    }
    return room;
  }

  public Room ofOwner(long ownerId) {
    String code = byOwner.get(ownerId);
    return code == null ? null : get(code);
  }

  /** 移出登记表并标记 closed；返回该房间（不存在返回 null）。 */
  public Room remove(String code) {
    Room room = rooms.get(code);
    if (room == null) return null;
    if (room.timer != null) room.timer.cancel();
    room.timer = null;
    room.status = "closed";
    rooms.remove(code);
    if (code.equals(byOwner.get(room.ownerId))) byOwner.remove(room.ownerId);
    return room;
  }

  /** 对外的 Room 视图（设计文档 5.4）；owner 由调用方查用户表给出。 */
  public Map<String, Object> view(Room room, Map<String, Object> owner) {
    boolean closed = !"waiting".equals(room.status);
    return Msg.of(
        "code", room.code,
        "owner", owner,
        "size", room.size,
        "color", room.color,
        "status", closed ? "closed" : "waiting",
        "expiresIn", closed ? 0L : Math.max(0, room.expiresAt - loop.now()));
  }

  public int count() {
    return rooms.size();
  }

  public void clear() {
    for (String code : new ArrayList<>(rooms.keySet())) remove(code);
  }
}
