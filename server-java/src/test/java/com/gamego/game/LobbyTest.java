package com.gamego.game;

import static com.gamego.game.Ctx.codeOf;
import static com.gamego.game.Ctx.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.gamego.db.User;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/** 匹配队列、好友房、大厅（对应 Node 测试 game/lobby.test.js 与 limits.test.js / fairness-manager.test.js 的大厅部分）。 */
class LobbyTest {

  static String json(Object o) {
    return Json.write(o);
  }

  // ---------------------------------------------------------------- Matchmaker

  @Test
  void matchmakerFifoPerSize() {
    Matchmaker m = new Matchmaker(() -> 0);
    assertThat(m.join(1, 9).pair()).isNull();
    assertThat(m.join(2, 13).pair()).isNull();
    assertThat(m.join(3, 9).pair()).containsExactly(1, 3);
    assertThat(m.statusOf(1)).isNull();
    assertThat(json(m.statusOf(2))).isEqualTo("{\"size\":13}");
    assertThat(m.queueLength(9)).isEqualTo(0);
    assertThatThrownBy(() -> m.join(4, 7)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void matchmakerOneQueuePerUser() {
    Matchmaker m = new Matchmaker(() -> 0);
    m.join(1, 9);
    assertThat(m.join(1, 9).pair()).isNull();
    assertThat(m.queueLength(9)).isEqualTo(1);
    m.join(1, 19);
    assertThat(m.queueLength(9)).isEqualTo(0);
    assertThat(json(m.statusOf(1))).isEqualTo("{\"size\":19}");
    assertThat(m.cancel(1)).isTrue();
    assertThat(m.cancel(1)).isFalse();
    assertThat(m.queueLength(19)).isEqualTo(0);
    m.join(5, 9);
    m.requeueFront(6, 9);
    assertThat(m.join(7, 9).pair()).containsExactly(6, 5);
    m.join(8, 9);
    m.clear();
    assertThat(m.statusOf(8)).isNull();
  }

  // ---------------------------------------------------------------- RoomRegistry

  static final class Reg {
    final ManualLoop loop = new ManualLoop();
    final List<RoomRegistry.Room> expired = new ArrayList<>();
    final RoomRegistry rooms;

    Reg(int... codes) {
      Deque<Integer> q = new ArrayDeque<>();
      for (int c : codes) q.add(c);
      rooms = new RoomRegistry(1000, loop, codes.length > 0 ? b -> q.poll() : null, expired::add, null);
    }
  }

  @Test
  void roomCodesUniqueOnePerOwner() {
    Reg r = new Reg(42, 42, 123456, 7);
    RoomRegistry.Created a = r.rooms.create(1, 9, "black");
    assertThat(a.room().code).isEqualTo("000042");
    assertThat(a.replaced()).isNull();
    RoomRegistry.Created b = r.rooms.create(2, 13, "random");
    assertThat(b.room().code).isEqualTo("123456");
    RoomRegistry.Created c = r.rooms.create(1, 19, "white");
    assertThat(c.replaced().code).isEqualTo("000042");
    assertThat(c.replaced().status()).isEqualTo("closed");
    assertThat(r.rooms.get("000042")).isNull();
    assertThat(r.rooms.ofOwner(1).code).isEqualTo("000007");
    assertThat(r.rooms.count()).isEqualTo(2);
    assertThat(r.rooms.get("abc")).isNull();
  }

  @Test
  void roomExpiresWithCallbackAndView() {
    Reg r = new Reg();
    RoomRegistry.Room room = r.rooms.create(1, 9, "black").room();
    r.loop.advance(400);
    Map<String, Object> v = r.rooms.view(room, Msg.of("userId", 1, "nickname", "A", "avatarUrl", ""));
    assertThat(json(v))
        .isEqualTo("{\"code\":\"" + room.code + "\",\"owner\":{\"userId\":1,\"nickname\":\"A\",\"avatarUrl\":\"\"},\"size\":9,"
            + "\"color\":\"black\",\"status\":\"waiting\",\"expiresIn\":600}");
    r.loop.advance(599);
    assertThat(r.expired).isEmpty();
    r.loop.advance(1);
    assertThat(r.expired).hasSize(1);
    assertThat(r.expired.get(0).status()).isEqualTo("closed");
    assertThat(r.rooms.get(room.code)).isNull();
    assertThat(r.rooms.ofOwner(1)).isNull();
    assertThat(r.rooms.view(room, null).get("expiresIn")).isEqualTo(0L);
  }

  @Test
  void roomRemoveAndClearCancelTimers() {
    Reg r = new Reg();
    RoomRegistry.Room room = r.rooms.create(1, 9, "black").room();
    r.rooms.create(2, 9, "black");
    assertThat(r.rooms.remove(room.code).code).isEqualTo(room.code);
    assertThat(r.rooms.remove(room.code)).isNull();
    r.rooms.clear();
    assertThat(r.loop.pendingTimers()).isEqualTo(0);
    r.loop.advance(5000);
    assertThat(r.expired).isEmpty();
    assertThatThrownBy(() -> new RoomRegistry(0, r.loop, null, null, null)).isInstanceOf(IllegalArgumentException.class);
  }

  // ---------------------------------------------------------------- Lobby

  static final class L {
    final Ctx ctx;
    final Matchmaker matchmaker;
    final RoomRegistry rooms;
    final Lobby lobby;

    L(Consumer<GameSettings.Builder> config) {
      ctx = new Ctx(b -> {
        b.roomTtlMs(5000);
        if (config != null) config.accept(b);
      }, null);
      matchmaker = new Matchmaker(ctx.loop::now);
      Lobby[] ref = new Lobby[1];
      rooms = new RoomRegistry(ctx.settings.roomTtlMs, ctx.loop, null, room -> ref[0].onRoomExpired(room), ctx.log);
      lobby = new Lobby(ctx.manager, matchmaker, rooms, ctx.store, ctx.hub, ctx.settings, ctx.log, ctx.loop, b -> 0);
      ref[0] = lobby;
    }

    L() {
      this(null);
    }
  }

  @Test
  void matchJoinCreatesRankedGame() {
    L l = new L();
    Ctx ctx = l.ctx;
    long a = ctx.alice.id();
    long b = ctx.bob.id();
    long c = ctx.carol.id();
    assertThat(json(l.lobby.matchJoin(a, 9))).isEqualTo("{\"size\":9}");
    assertThat(json(l.lobby.hello(a))).isEqualTo("{\"activeGames\":[],\"room\":null,\"matching\":{\"size\":9}}");
    assertThat(json(l.lobby.matchJoin(b, 9))).isEqualTo("{\"size\":9}");
    List<Map<String, Object>> found = ctx.hub.of("match.found");
    assertThat(found).hasSize(2);
    GameSession s = ctx.manager.getSession((String) found.get(0).get("gameId"));
    assertThat(s.mode()).isEqualTo("ranked");
    assertThat(s.player(1)).isEqualTo(a);
    assertThat(s.player(2)).isEqualTo(b);
    assertThat(codeOf(() -> l.lobby.matchJoin(a, 13))).isEqualTo("in_game");
    assertThat(codeOf(() -> l.lobby.roomCreate(b, 9, "black"))).isEqualTo("in_game");
    assertThat(codeOf(() -> l.lobby.matchJoin(c, 7))).isEqualTo("bad_request");
    assertThat(json(l.lobby.hello(a).get("activeGames"))).isEqualTo("[{\"id\":\"" + s.id() + "\",\"mode\":\"ranked\"}]");
    l.lobby.matchJoin(c, 9);
    l.lobby.matchCancel(c);
    l.lobby.matchCancel(c);
    assertThat(l.lobby.hello(c).get("matching")).isNull();
  }

  @Test
  void matchCreateFailureRequeues() {
    L l = new L();
    l.lobby.matchJoin(l.ctx.alice.id(), 9);
    l.ctx.store.failOn("games.insert");
    assertThatThrownBy(() -> l.lobby.matchJoin(l.ctx.bob.id(), 9)).hasMessageContaining("games.insert");
    assertThat(json(l.matchmaker.statusOf(l.ctx.alice.id()))).isEqualTo("{\"size\":9}");
    assertThat(l.matchmaker.statusOf(l.ctx.bob.id())).isNull();
  }

  @Test
  void friendRoomFlow() {
    L l = new L();
    Ctx ctx = l.ctx;
    long a = ctx.alice.id();
    long b = ctx.bob.id();
    long c = ctx.carol.id();
    l.lobby.matchJoin(a, 9);
    Map<String, Object> room = map(l.lobby.roomCreate(a, 13, "white").get("room"));
    assertThat(l.matchmaker.statusOf(a)).as("建房取消匹配").isNull();
    String code = (String) room.get("code");
    assertThat(code).matches("^\\d{6}$");
    assertThat(json(room.get("owner"))).isEqualTo("{\"userId\":" + a + ",\"nickname\":\"Alice\",\"avatarUrl\":\"http://test.local/avatars/a1.png\"}");
    assertThat(room.get("status")).isEqualTo("waiting");
    assertThat(room.get("expiresIn")).isEqualTo(5000L);
    assertThat(json(l.lobby.hello(a).get("room"))).isEqualTo(json(room));
    assertThat(codeOf(() -> l.lobby.roomGet(b, "999999"))).isEqualTo("room_not_found");
    assertThat(json(l.lobby.roomGet(b, code).get("room"))).isEqualTo(json(room));
    l.lobby.roomGet(c, code);
    assertThat(codeOf(() -> l.lobby.roomJoin(a, code))).isEqualTo("own_room");
    String gameId = (String) l.lobby.roomJoin(b, code).get("gameId");
    GameSession s = ctx.manager.getSession(gameId);
    assertThat(s.mode()).isEqualTo("friend");
    assertThat(s.size()).isEqualTo(13);
    assertThat(s.player(1)).isEqualTo(b);
    assertThat(s.player(2)).isEqualTo(a);
    assertThat(json(ctx.hub.of("game.start", a))).isEqualTo("[{\"t\":\"game.start\",\"gameId\":\"" + gameId + "\",\"mode\":\"friend\"}]");
    assertThat(json(ctx.hub.of("game.start", b))).isEqualTo("[{\"t\":\"game.start\",\"gameId\":\"" + gameId + "\",\"mode\":\"friend\"}]");
    List<Map<String, Object>> upd = ctx.hub.of("room.update", c);
    assertThat(upd).hasSize(1);
    assertThat(map(upd.get(0).get("room")).get("status")).isEqualTo("closed");
    assertThat(ctx.hub.of("room.update", b)).isEmpty();
    assertThat(codeOf(() -> l.lobby.roomJoin(c, code))).isEqualTo("room_not_found");
    assertThat(l.lobby.hello(a).get("room")).isNull();
  }

  @Test
  void joinWhileInGameAndOwnerBusy() {
    L l = new L();
    Ctx ctx = l.ctx;
    Map<String, Object> room = map(l.lobby.roomCreate(ctx.alice.id(), 9, "random").get("room"));
    String code = (String) room.get("code");
    ctx.manager.createHumanGame("ranked", 9, ctx.bob.id(), ctx.carol.id());
    assertThat(codeOf(() -> l.lobby.roomJoin(ctx.bob.id(), code))).isEqualTo("in_game");
    User x = ctx.store.createUser("x", "X", null, 0);
    ctx.manager.createHumanGame("friend", 9, ctx.alice.id(), x.id());
    User dave = ctx.store.createUser("dave", "Dave", null, 0);
    assertThat(codeOf(() -> l.lobby.roomJoin(dave.id(), code))).isEqualTo("room_not_found");
    assertThat(l.rooms.get(code)).isNull();
  }

  @Test
  void roomReplaceLeaveMatchAndExpiryNotify() {
    L l = new L();
    Ctx ctx = l.ctx;
    long a = ctx.alice.id();
    long b = ctx.bob.id();
    long c = ctx.carol.id();
    Map<String, Object> r1 = map(l.lobby.roomCreate(a, 9, "black").get("room"));
    l.lobby.roomGet(b, (String) r1.get("code"));
    Map<String, Object> r2 = map(l.lobby.roomCreate(a, 9, "black").get("room"));
    assertThat(r2.get("code")).isNotEqualTo(r1.get("code"));
    assertThat(map(ctx.hub.last("room.update", b).get("room")).get("code")).isEqualTo(r1.get("code"));
    assertThat(ctx.hub.of("room.update", a)).isEmpty();
    l.lobby.roomGet(b, (String) r2.get("code"));
    l.lobby.roomLeave(a);
    assertThat(map(ctx.hub.last("room.update", b).get("room")).get("code")).isEqualTo(r2.get("code"));
    l.lobby.roomLeave(a);
    Map<String, Object> r3 = map(l.lobby.roomCreate(a, 9, "black").get("room"));
    l.lobby.roomGet(c, (String) r3.get("code"));
    l.lobby.matchJoin(a, 9);
    assertThat(map(ctx.hub.last("room.update", c).get("room")).get("code")).isEqualTo(r3.get("code"));
    l.lobby.matchCancel(a);
    Map<String, Object> r4 = map(l.lobby.roomCreate(a, 19, "white").get("room"));
    l.lobby.roomGet(c, (String) r4.get("code"));
    ctx.hub.clear();
    ctx.loop.advance(5000);
    List<Map<String, Object>> toOwner = ctx.hub.of("room.update", a);
    assertThat(toOwner).hasSize(1);
    Map<String, Object> closed = map(toOwner.get(0).get("room"));
    assertThat(closed.get("code")).isEqualTo(r4.get("code"));
    assertThat(closed.get("status")).isEqualTo("closed");
    assertThat(closed.get("expiresIn")).isEqualTo(0L);
    assertThat(ctx.hub.of("room.update", c)).hasSize(1);
    assertThat(l.lobby.hello(a).get("room")).isNull();
  }

  @Test
  void aiStartValidationAndOfflineCancelsMatch() {
    L l = new L();
    long a = l.ctx.alice.id();
    assertThat(codeOf(() -> l.lobby.aiStart(a, 8, "k10", "black"))).isEqualTo("bad_request");
    assertThat(codeOf(() -> l.lobby.aiStart(a, 9, "k10", "purple"))).isEqualTo("bad_request");
    assertThat(codeOf(() -> l.lobby.aiStart(a, 9, "", "black"))).isEqualTo("bad_request");
    String gameId = (String) l.lobby.aiStart(a, 9, "k10", "black").get("gameId");
    assertThat(l.ctx.manager.getSession(gameId).mode()).isEqualTo("ai");
    l.lobby.matchJoin(a, 9);
    l.lobby.userOffline(a);
    assertThat(l.lobby.hello(a).get("matching")).isNull();
  }

  @Test
  void aiStartRateLimitAndInGame() {
    L l = new L();
    Ctx ctx = l.ctx;
    long a = ctx.alice.id();
    for (int i = 0; i < 5; i++) l.lobby.aiStart(a, 9, "k10", "black");
    assertThat(codeOf(() -> l.lobby.aiStart(a, 9, "k10", "black"))).isEqualTo("rate_limited");
    ctx.loop.advance(10000);
    l.lobby.aiStart(a, 9, "k10", "black");
    assertThat(codeOf(() -> l.lobby.aiStart(a, 9, "k10", "black"))).isEqualTo("rate_limited");
    l.lobby.matchJoin(ctx.bob.id(), 9);
    l.lobby.matchJoin(ctx.carol.id(), 9);
    assertThat(ctx.manager.humanGameOf(ctx.bob.id())).isNotNull();
    assertThat(codeOf(() -> l.lobby.aiStart(ctx.bob.id(), 9, "k10", "black"))).isEqualTo("in_game");
  }

  @Test
  void roomGuessRateLimit() {
    L l = new L(b -> b.roomTtlMs(60000));
    Ctx ctx = l.ctx;
    long a = ctx.alice.id();
    long b = ctx.bob.id();
    String code = (String) map(l.lobby.roomCreate(a, 9, "black").get("room")).get("code");
    for (int i = 0; i < 10; i++) {
      l.lobby.roomGet(b, code);
      String guess = String.valueOf(100000 + i);
      if (guess.equals(code)) guess = "999999";
      String g = guess;
      assertThat(codeOf(() -> l.lobby.roomGet(b, g))).isEqualTo("room_not_found");
    }
    assertThat(codeOf(() -> l.lobby.roomGet(b, "123456"))).isEqualTo("rate_limited");
    assertThat(codeOf(() -> l.lobby.roomJoin(b, code))).as("暂停期间真的房号也查不了").isEqualTo("rate_limited");
    ctx.loop.advance(6000);
    l.lobby.roomJoin(b, code);
    assertThat(codeOf(() -> l.lobby.roomGet(ctx.carol.id(), "654321"))).as("别人不受影响").isEqualTo("room_not_found");
  }

  @Test
  void replacedConnectionLeavesQueueKeepsRoom() {
    L l = new L(b -> b.roomTtlMs(60000));
    Ctx ctx = l.ctx;
    long a = ctx.alice.id();
    long b = ctx.bob.id();
    long c = ctx.carol.id();
    l.lobby.matchJoin(a, 9);
    l.lobby.userReplaced(a);
    assertThat(l.lobby.hello(a).get("matching")).isNull();
    l.lobby.matchJoin(b, 9);
    assertThat(ctx.manager.humanGameOf(a)).as("没有在不知情的情况下被配对").isNull();
    String code = (String) map(l.lobby.roomCreate(c, 9, "black").get("room")).get("code");
    l.lobby.userReplaced(c);
    assertThat(map(l.lobby.hello(c).get("room")).get("code")).isEqualTo(code);
    ctx.hub.online.remove(c);
    String gameId = (String) l.lobby.roomJoin(a, code).get("gameId");
    GameSession s = ctx.manager.getSession(gameId);
    assertThat(s.awaitingArrival(1)).isTrue();
    assertThat(json(l.lobby.hello(c).get("activeGames"))).isEqualTo("[{\"id\":\"" + gameId + "\",\"mode\":\"friend\"}]");
  }

  @Test
  void pruneRateLimitTables() {
    L l = new L(b -> b.roomTtlMs(60000));
    for (long uid = 1000; uid < 1100; uid++) {
      l.lobby.aiStartLimit.take(uid);
      l.lobby.roomMissLimit.take(uid);
    }
    assertThat(l.lobby.aiStartLimitSize()).isEqualTo(100);
    l.lobby.prune();
    assertThat(l.lobby.aiStartLimitSize()).as("还没补满的不清").isEqualTo(100);
    l.ctx.loop.advance(60000);
    l.lobby.prune();
    assertThat(l.lobby.aiStartLimitSize()).isEqualTo(0);
    assertThat(l.lobby.roomMissLimitSize()).isEqualTo(0);
    l.rooms.clear();
  }
}
