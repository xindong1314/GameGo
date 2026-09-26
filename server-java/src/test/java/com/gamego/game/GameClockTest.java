package com.gamego.game;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.gamego.config.TimeControl;
import com.gamego.game.GameClock.Consumed;
import com.gamego.game.GameClock.Side;
import com.gamego.game.GameClock.View;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** 读秒各分支（对应 Node 测试 game/clock.test.js）。 */
class GameClockTest {

  static final TimeControl TC = new TimeControl(60000, 3, 10000);
  static final long P = TC.periodMs();

  @Test
  void normalizeTimeControl() {
    assertThat(GameClock.normalizeTimeControl(TC)).isEqualTo(TC);
    assertThat(GameClock.normalizeTimeControl(new TimeControl(0, 2, 5000))).isEqualTo(new TimeControl(0, 2, 5000));
    assertThat(GameClock.normalizeTimeControl(new TimeControl(5000, 0, 0))).isEqualTo(new TimeControl(5000, 0, 0));
    assertThatThrownBy(() -> GameClock.normalizeTimeControl(null)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> GameClock.normalizeTimeControl(new TimeControl(-1, 3, 1000))).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> GameClock.normalizeTimeControl(new TimeControl(1000, 3, 0))).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> GameClock.normalizeTimeControl(new TimeControl(0, 0, 0))).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void consumeBranches() {
    assertThat(GameClock.consume(new Side(60000, 3), 15000, P)).isEqualTo(new Consumed(new Side(45000, 3), false));
    // 恰好用完基本时间 → 基本时间归零，读秒次数不变
    assertThat(GameClock.consume(new Side(60000, 3), 60000, P)).isEqualTo(new Consumed(new Side(0, 3), false));
    // 周期内完成则周期重置
    assertThat(GameClock.consume(new Side(60000, 3), 60000 + 9999, P)).isEqualTo(new Consumed(new Side(0, 3), false));
    // 用满一个完整周期消耗一次（恰好边界也算消耗）
    assertThat(GameClock.consume(new Side(60000, 3), 70000, P).side()).isEqualTo(new Side(0, 2));
    assertThat(GameClock.consume(new Side(0, 3), 10000, P).side()).isEqualTo(new Side(0, 2));
    assertThat(GameClock.consume(new Side(0, 3), 9999, P).side()).isEqualTo(new Side(0, 3));
    // 一手跨多个周期
    assertThat(GameClock.consume(new Side(5000, 3), 30000, P)).isEqualTo(new Consumed(new Side(0, 1), false));
    // 耗时达到 基本时间 + 次数×周期 即超时（恰好边界算超时）
    assertThat(GameClock.consume(new Side(5000, 3), 35000, P)).isEqualTo(new Consumed(new Side(0, 0), true));
    assertThat(GameClock.consume(new Side(5000, 3), 34999, P)).isEqualTo(new Consumed(new Side(0, 1), false));
    assertThat(GameClock.consume(new Side(0, 1), 10000, P).timedOut()).isTrue();
    assertThat(GameClock.consume(new Side(0, 1), 99999, P).timedOut()).isTrue();
    // 没有读秒时基本时间用完即超时
    assertThat(GameClock.consume(new Side(5000, 0), 5000, 0).timedOut()).isTrue();
    assertThat(GameClock.consume(new Side(5000, 0), 4999, 0)).isEqualTo(new Consumed(new Side(1, 0), false));
    // 负数耗时按 0
    assertThat(GameClock.consume(new Side(1000, 2), -500, P).side()).isEqualTo(new Side(1000, 2));
  }

  @Test
  void sideView() {
    Side side = new Side(30000, 3);
    assertThat(GameClock.sideView(side, 0, P)).isEqualTo(new View(30000, 3, 10000));
    assertThat(GameClock.sideView(side, 12345, P)).isEqualTo(new View(17655, 3, 10000));
    assertThat(GameClock.sideView(side, 30000, P)).isEqualTo(new View(0, 3, 10000));
    assertThat(GameClock.sideView(side, 34000, P)).isEqualTo(new View(0, 3, 6000));
    assertThat(GameClock.sideView(side, 41000, P)).isEqualTo(new View(0, 2, 9000));
    assertThat(GameClock.sideView(side, 59999, P)).isEqualTo(new View(0, 1, 1));
    assertThat(GameClock.sideView(side, 60000, P)).isEqualTo(new View(0, 0, 0));
    assertThat(GameClock.totalMs(side, P)).isEqualTo(60000);
    assertThat(GameClock.msUntilTimeout(side, 45000, P)).isEqualTo(15000);
    assertThat(GameClock.msUntilTimeout(side, 70000, P)).isEqualTo(0);
  }

  @Test
  void startStop() {
    GameClock c = new GameClock(TC);
    long t0 = 1000;
    c.start(1, t0);
    assertThat(c.running()).isEqualTo(1);
    assertThat(c.timeoutAt()).isEqualTo(t0 + 90000);
    assertThat(c.msUntilTimeout(t0 + 1000)).isEqualTo(89000);
    c.start(2, t0 + 20000);
    assertThat(c.side(1)).isEqualTo(new Side(40000, 3));
    assertThat(c.running()).isEqualTo(2);
    assertThat(c.stop(t0 + 25000)).isEqualTo(new GameClock.Stopped(2, false));
    assertThat(c.side(2)).isEqualTo(new Side(55000, 3));
    assertThat(c.running()).isEqualTo(0);
    assertThat(c.timeoutAt()).isNull();
    assertThat(c.msUntilTimeout(0)).isNull();
    assertThat(c.stop(t0 + 30000)).isEqualTo(new GameClock.Stopped(0, false));
  }

  @Test
  void snapshot() {
    GameClock c = new GameClock(TC);
    c.setSide(2, new Side(0, 2));
    c.start(2, 0);
    Map<String, Object> snap = c.snapshot(3500);
    assertThat(Json.write(snap))
        .isEqualTo("{\"1\":{\"mainMs\":60000,\"periodsLeft\":3,\"periodMs\":10000},\"2\":{\"mainMs\":0,\"periodsLeft\":2,\"periodMs\":6500},\"running\":2}");
    assertThat(Json.write(c.snapshot(13500).get("2"))).isEqualTo("{\"mainMs\":0,\"periodsLeft\":1,\"periodMs\":6500}");
    c.stop(4000);
    assertThat(Json.write(c.snapshot(99999).get("2"))).isEqualTo("{\"mainMs\":0,\"periodsLeft\":2,\"periodMs\":10000}");
    assertThat(c.snapshot(99999).get("running")).isNull();
  }

  @Test
  void timeoutAndZero() {
    GameClock c = new GameClock(new TimeControl(1000, 1, 1000));
    c.start(1, 0);
    assertThat(c.isTimedOut(1999)).isFalse();
    assertThat(c.isTimedOut(2000)).isTrue();
    assertThat(c.stop(2500)).isEqualTo(new GameClock.Stopped(1, true));
    assertThat(c.side(1)).isEqualTo(new Side(0, 0));

    GameClock z = new GameClock(TC);
    z.start(1, 0);
    z.zero(1);
    assertThat(z.side(1)).isEqualTo(new Side(0, 0));
    assertThat(z.running()).isEqualTo(0);
    assertThatThrownBy(() -> z.start(3, 0)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void persistence() throws Exception {
    GameClock c = new GameClock(TC);
    c.start(1, 0);
    c.start(2, 70000); // 黑进入读秒
    String saved = Json.write(c.toJson());
    assertThat(saved)
        .isEqualTo("{\"1\":{\"mainMs\":0,\"periodsLeft\":2,\"periodMs\":10000},\"2\":{\"mainMs\":60000,\"periodsLeft\":3,\"periodMs\":10000},\"running\":2}");
    GameClock r = new GameClock(TC, Json.parse(saved));
    assertThat(r.side(1)).isEqualTo(new Side(0, 2));
    assertThat(r.side(2)).isEqualTo(new Side(60000, 3));
    assertThat(r.running()).isEqualTo(0);
    GameClock bad = new GameClock(TC, Json.parse("{\"1\":{\"mainMs\":-5,\"periodsLeft\":1},\"2\":\"x\"}"));
    assertThat(bad.side(1)).isEqualTo(new Side(60000, 3));
    assertThat(bad.side(2)).isEqualTo(new Side(60000, 3));
    assertThat(new GameClock(TC, null).side(1)).isEqualTo(new Side(60000, 3));
  }
}
