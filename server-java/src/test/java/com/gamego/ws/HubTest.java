package com.gamego.ws;

import static org.assertj.core.api.Assertions.assertThat;

import com.gamego.game.ManualLoop;
import com.gamego.game.Msg;
import com.gamego.game.RecordingLog;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** 连接层（对应 Node 测试 ws-limits.test.js 的慢读客户端与 e2e.test.js 的心跳、batch 顺序）。 */
class HubTest {

  /** 记录发送内容的 Transport。 */
  static final class FakeTransport implements Transport {
    final List<String> sent = new ArrayList<>();
    int pings = 0;
    int terminated = 0;
    Integer closedWith = null;
    long buffered = 0;
    boolean open = true;

    @Override
    public boolean isOpen() {
      return open && closedWith == null && terminated == 0;
    }

    @Override
    public boolean isConnected() {
      return isOpen();
    }

    @Override
    public long bufferedBytes() {
      return buffered;
    }

    @Override
    public boolean sendText(String text) {
      if (!isOpen()) return false;
      sent.add(text);
      return true;
    }

    @Override
    public void ping() {
      pings += 1;
    }

    @Override
    public void close(int code, String reason) {
      closedWith = code;
    }

    @Override
    public void terminate() {
      terminated += 1;
    }
  }

  static final class Setup {
    final ManualLoop loop = new ManualLoop();
    final RecordingLog log = new RecordingLog();
    final Hub hub = new Hub(loop, log, null);
    final List<String> events = new ArrayList<>();

    Setup() {
      hub.setHandlers(
          new Hub.Handlers() {
            @Override
            public void onOpen(Connection conn) {
              events.add("open:" + conn.userId());
            }

            @Override
            public void onReplace(Connection conn) {
              events.add("replace:" + conn.userId());
            }

            @Override
            public void onClose(Connection conn) {
              events.add("close:" + conn.userId());
            }

            @Override
            public void onMessage(Connection conn, Protocol.Parsed msg) {
              events.add("msg:" + msg.t());
            }
          });
      hub.start();
    }

    Connection open(FakeTransport t, long uid) {
      Connection c = hub.open(t, uid);
      loop.flush();
      return c;
    }
  }

  @Test
  void slowReaderIsTerminated() {
    Setup s = new Setup();
    FakeTransport t = new FakeTransport();
    Connection conn = s.open(t, 7);
    assertThat(conn.sendNow(Msg.of("t", "pong"))).isTrue();
    t.buffered = Hub.MAX_BUFFERED_BYTES; // 正好等于上限：还可以
    assertThat(conn.sendNow(Msg.of("t", "pong"))).isTrue();
    t.buffered = Hub.MAX_BUFFERED_BYTES + 1;
    assertThat(conn.sendNow(Msg.of("t", "pong"))).isFalse();
    assertThat(t.sent).hasSize(2);
    assertThat(t.terminated).isEqualTo(1);
    assertThat(conn.closing).isTrue();
    assertThat(s.log.warn).hasSize(1);
  }

  @Test
  void heartbeatTerminatesAfterTwoMissedPongs() {
    Setup s = new Setup();
    FakeTransport mute = new FakeTransport();
    FakeTransport good = new FakeTransport();
    Connection m = s.open(mute, 1);
    Connection g = s.open(good, 2);
    s.loop.advance(Hub.PING_INTERVAL_MS);
    s.hub.onPong(g);
    s.loop.advance(Hub.PING_INTERVAL_MS);
    s.hub.onPong(g);
    assertThat(mute.terminated).isEqualTo(0);
    assertThat(mute.pings).isEqualTo(2);
    s.loop.advance(Hub.PING_INTERVAL_MS);
    assertThat(mute.terminated).isEqualTo(1);
    assertThat(m.closing).isTrue();
    assertThat(good.terminated).isEqualTo(0);
    assertThat(good.pings).isEqualTo(3);
  }

  @Test
  void replaceKicksOldAndBatchOrdersPushesAfterSendNow() {
    Setup s = new Setup();
    FakeTransport t1 = new FakeTransport();
    FakeTransport t2 = new FakeTransport();
    Connection c1 = s.open(t1, 5);
    Connection c2 = s.open(t2, 5);
    assertThat(t1.sent).containsExactly("{\"t\":\"kicked\",\"reason\":\"replaced\"}");
    assertThat(t1.closedWith).isEqualTo(4001);
    assertThat(c1.replaced).isTrue();
    assertThat(s.events).containsExactly("open:5", "replace:5");
    // 被顶替的连接关闭时不算掉线
    s.hub.closed(c1);
    s.loop.flush();
    assertThat(s.events).containsExactly("open:5", "replace:5");
    // batch：期间的推送排在 sendNow 之后
    s.hub.batch(() -> {
      s.hub.send(5, Msg.of("t", "push"));
      c2.sendNow(Msg.of("t", "res"));
    });
    assertThat(t2.sent).containsExactly("{\"t\":\"res\"}", "{\"t\":\"push\"}");
    // sendGame 只发给订阅了的连接
    s.hub.sendGame(5, "abcdefghij12", Msg.of("t", "game.move"));
    assertThat(t2.sent).hasSize(2);
    c2.subscribe("abcdefghij12");
    s.hub.sendGame(5, "abcdefghij12", Msg.of("t", "game.move"));
    assertThat(t2.sent).hasSize(3);
    s.hub.closed(c2);
    s.loop.flush();
    assertThat(s.events).containsExactly("open:5", "replace:5", "close:5");
    assertThat(s.hub.isOnline(5)).isFalse();
  }

  @Test
  void rateLimitClosesAfterQueuedReplies() {
    Setup s = new Setup();
    FakeTransport t = new FakeTransport();
    Connection c = s.open(t, 9);
    for (int i = 0; i < 25; i++) s.hub.onText(c, "{\"t\":\"hello\"}");
    s.loop.flush();
    assertThat(s.events.stream().filter(e -> e.equals("msg:hello")).count()).isEqualTo(20);
    assertThat(t.closedWith).isEqualTo(Hub.CLOSE_RATE_LIMITED);
  }

  @Test
  void subscriptionsAreBounded() {
    Setup s = new Setup();
    Connection c = s.open(new FakeTransport(), 3);
    for (int i = 0; i < 40; i++) c.subscribe(String.format("g%011d", i));
    assertThat(c.isSubscribed(String.format("g%011d", 0))).isFalse();
    assertThat(c.isSubscribed(String.format("g%011d", 39))).isTrue();
  }
}
