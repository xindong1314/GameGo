package com.gamego.ai;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** 移植自 server/test/ai/levels.test.js。 */
class LevelsTest {
  @Test
  void matchesDesignDocTable() {
    List<String> got = new ArrayList<>();
    for (Levels.Level l : Levels.LEVELS) got.add(l.id() + "|" + l.name() + "|" + l.kind() + "|" + l.kyu());
    assertEquals(
        Arrays.asList(
            "k18|入门|rank|18",
            "k12|初级|rank|12",
            "k8|中级|rank|8",
            "k4|中高级|rank|4",
            "k1|高级|rank|1",
            "d3|业余 3 段|rank|-2",
            "d5|业余高段|policy|null",
            "max|最强|search|null"),
        got);
    assertEquals(22, Levels.get("d5").openingMoves());
    assertEquals(300, Levels.get("max").maxVisits());
    assertEquals(8, Levels.get("max").maxTimeSec());
    assertNull(Levels.get("nope"));
    assertEquals(8, Levels.LEVEL_IDS.size());
    assertThrows(UnsupportedOperationException.class, () -> Levels.LEVELS.add(null));
  }

  @Test
  void descriptionsMention19x19Strength() {
    for (Levels.Level l : Levels.LEVELS) {
      assertTrue(l.desc().contains("19 路"), l.id());
      assertTrue(l.desc().length() > 5 && !l.name().isEmpty());
    }
    assertTrue(Levels.get("k18").desc().contains("约 18 级"));
    assertTrue(Levels.get("k1").desc().contains("约 1 级"));
    assertTrue(Levels.get("d3").desc().contains("约业余 3 段"));
  }

  @Test
  void publicLevelsOnlyIdNameDesc() {
    List<AiLevel> pub = Levels.publicLevels();
    assertEquals(8, pub.size());
    assertEquals(new AiLevel("k18", "入门", Levels.get("k18").desc()), pub.get(0));
    assertThrows(UnsupportedOperationException.class, () -> pub.set(0, null));
  }

  @Test
  void smallBoardKyuOffsets() {
    assertEquals(Map.of(9, 10, 13, 5, 19, 0), Levels.SIZE_KYU_OFFSET);
    assertEquals(30, Levels.MAX_KYU);
    assertEquals(8, Levels.kyuFor(Levels.get("k8"), 19));
    assertEquals(13, Levels.kyuFor(Levels.get("k8"), 13));
    assertEquals(18, Levels.kyuFor(Levels.get("k8"), 9));
    assertEquals(8, Levels.kyuFor(Levels.get("d3"), 9));
    assertEquals(3, Levels.kyuFor(Levels.get("d3"), 13));
    assertEquals(23, Levels.kyuFor(Levels.get("k18"), 13));
    assertEquals(28, Levels.kyuFor(Levels.get("k18"), 9));
    Levels.Level weak = new Levels.Level("weak", "W", Levels.KIND_RANK, 25, null, null, null, "");
    assertEquals(30, Levels.kyuFor(weak, 9), "上限 30");
    IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> Levels.kyuFor(Levels.get("max"), 19));
    assertTrue(e.getMessage().contains("不是 rank 档"));
  }
}
