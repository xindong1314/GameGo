package com.gamego.engine;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import java.util.stream.IntStream;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * 与 JS 引擎的交叉验证：重放 gen-fixtures.js 生成的 cross-validation.json（JS 引擎的逐步结果），
 * 断言 Java 引擎每一步的输出都完全一致。夹具需在仓库根目录用
 * {@code node server-java/src/test/resources/engine/gen-fixtures.js} 重新生成。
 */
class CrossValidationTest {

    private static JsonNode root;
    private static final AtomicInteger GAMES = new AtomicInteger();
    private static final AtomicInteger OPS = new AtomicInteger();
    private static final AtomicInteger STANDALONE = new AtomicInteger();

    @BeforeAll
    static void load() throws Exception {
        try (InputStream in = CrossValidationTest.class.getResourceAsStream("/engine/cross-validation.json")) {
            assertNotNull(in, "缺少夹具 /engine/cross-validation.json，请先运行 gen-fixtures.js");
            root = new ObjectMapper().readTree(in);
        }
    }

    @AfterAll
    static void report() {
        System.out.printf("[engine cross-validation] games=%d, in-game ops=%d, standalone cases=%d%n",
                GAMES.get(), OPS.get(), STANDALONE.get());
    }

    // ---------- JSON 工具 ----------

    private static int[] ints(JsonNode node) {
        if (node == null || node.isNull()) return null;
        int[] out = new int[node.size()];
        for (int i = 0; i < out.length; i++) out[i] = node.get(i).asInt();
        return out;
    }

    private static Integer optInt(JsonNode node) {
        return node == null || node.isNull() ? null : node.asInt();
    }

    private static Double optDouble(JsonNode node) {
        return node == null || node.isNull() ? null : node.asDouble();
    }

    private static String optText(JsonNode node) {
        return node == null || node.isNull() ? null : node.asText();
    }

    /** [winner, reason, black, white] → Result */
    private static Result resultOf(JsonNode arr) {
        if (arr == null || arr.isNull()) return null;
        return new Result(arr.get(0).asInt(), arr.get(1).asText(), optDouble(arr.get(2)), optDouble(arr.get(3)));
    }

    private static String cellsString(byte[] cells) {
        StringBuilder sb = new StringBuilder(cells.length);
        for (byte c : cells) sb.append((char) ('0' + c));
        return sb.toString();
    }

    private static String intsString(int[] a) {
        StringBuilder sb = new StringBuilder(a.length);
        for (int c : a) sb.append((char) ('0' + c));
        return sb.toString();
    }

    private static void assertScore(JsonNode r, Score.ScoreResult s, Supplier<String> where) {
        assertEquals(r.get(0).asDouble(), s.black(), () -> where.get() + " black");
        assertEquals(r.get(1).asDouble(), s.white(), () -> where.get() + " white");
        assertEquals(r.get(2).asInt(), s.winner(), () -> where.get() + " winner");
        assertEquals(r.get(3).asInt(), s.blackStones(), () -> where.get() + " blackStones");
        assertEquals(r.get(4).asInt(), s.whiteStones(), () -> where.get() + " whiteStones");
        assertEquals(r.get(5).asInt(), s.blackArea(), () -> where.get() + " blackArea");
        assertEquals(r.get(6).asInt(), s.whiteArea(), () -> where.get() + " whiteArea");
    }

    private static void assertState(JsonNode s, GameState st, Supplier<String> where) {
        assertEquals(s.get(0).asInt(), st.toPlay, () -> where.get() + " toPlay");
        assertEquals(optInt(s.get(1)), st.ko, () -> where.get() + " ko");
        assertEquals(s.get(2).asInt(), st.captures[Go.BLACK], () -> where.get() + " captures[B]");
        assertEquals(s.get(3).asInt(), st.captures[Go.WHITE], () -> where.get() + " captures[W]");
        assertEquals(s.get(4).asInt(), st.consecutivePasses, () -> where.get() + " consecutivePasses");
        assertEquals(s.get(5).asText(), st.status.substring(0, 1), () -> where.get() + " status");
        assertEquals(s.get(6).asInt(), st.history.size(), () -> where.get() + " history.length");
    }

    private static void assertMove(JsonNode h, Move m, Supplier<String> where) {
        assertEquals(h.get(0).asInt(), m.color(), () -> where.get() + " h.color");
        assertEquals(optInt(h.get(1)), m.idx(), () -> where.get() + " h.idx");
        assertArrayEquals(ints(h.get(2)), m.captured(), () -> where.get() + " h.captured");
        assertEquals(optInt(h.get(3)), m.koBefore(), () -> where.get() + " h.koBefore");
        assertEquals(optInt(h.get(4)), m.koAfter(), () -> where.get() + " h.koAfter");
        assertEquals(h.get(5).asInt(), m.passesBefore(), () -> where.get() + " h.passesBefore");
    }

    // ---------- 对局 ----------

    @TestFactory
    Stream<DynamicTest> games() {
        JsonNode games = root.get("games");
        return IntStream.range(0, games.size()).mapToObj(gi -> {
            JsonNode g = games.get(gi);
            String name = "game #" + gi + " (" + g.get("size").asInt() + " 路, " + g.get("ops").size() + " ops)";
            return DynamicTest.dynamicTest(name, () -> replayGame(gi, g));
        });
    }

    private void replayGame(int gi, JsonNode g) {
        int size = g.get("size").asInt();
        double komi = g.get("komi").asDouble();
        GameState st = Game.createGame(size, komi, g.get("autoScore").asBoolean());
        byte[] expected = new byte[size * size];
        JsonNode ops = g.get("ops");
        for (int k = 0; k < ops.size(); k++) {
            JsonNode op = ops.get(k);
            final int step = k;
            Supplier<String> where = () -> "game #" + gi + " op #" + step + " " + op;
            String o = op.get("o").asText();
            switch (o) {
                case "play", "pass", "undo", "resign", "resume", "finish" -> {
                    String actual = runGameOp(o, op, st);
                    JsonNode r = op.get("r");
                    String want = r.isBoolean() ? String.valueOf(r.asBoolean()) : r.asText();
                    assertEquals(want, actual, () -> where.get() + " result");
                    JsonNode d = op.get("d");
                    for (int j = 0; j < d.size(); j += 2) expected[d.get(j).asInt()] = (byte) d.get(j + 1).asInt();
                    assertArrayEquals(expected, st.board.cells, () -> where.get() + " board");
                    assertState(op.get("s"), st, where);
                    if (op.has("h")) assertMove(op.get("h"), st.history.get(st.history.size() - 1), where);
                    assertEquals(resultOf(op.get("res")), st.result, () -> where.get() + " result object");
                }
                case "can" -> {
                    OpResult r = Rules.canPlay(st.board, op.get("c").asInt(), optInt(op.get("k")), op.get("i").asInt());
                    assertEquals(op.get("r").asText(), r.ok() ? "ok" : r.reason(), () -> where.get() + " canPlay");
                    if (r.ok()) assertNull(r.reason(), where);
                    assertArrayEquals(expected, st.board.cells, () -> where.get() + " canPlay 不应改动棋盘");
                }
                case "grp" -> {
                    int i = op.get("i").asInt();
                    assertArrayEquals(ints(op.get("nb")), st.board.neighbors(i), () -> where.get() + " neighbors");
                    Board.Group grp = st.board.group(i);
                    JsonNode want = op.get("g");
                    if (want.isNull()) {
                        assertNull(grp, where);
                    } else {
                        assertNotNull(grp, where);
                        assertEquals(want.get(0).asInt(), grp.color(), where);
                        assertArrayEquals(ints(want.get(1)), grp.stones(), () -> where.get() + " stones");
                        assertArrayEquals(ints(want.get(2)), grp.liberties(), () -> where.get() + " liberties");
                    }
                }
                case "score" -> {
                    Score.ScoreResult s = Score.score(st.board, op.get("k").asDouble());
                    assertScore(op.get("r"), s, where);
                    assertNull(s.owner());
                    assertNull(s.dead());
                }
                case "area" -> {
                    int[] dead = ints(op.get("dead"));
                    int[] copy = dead == null ? null : dead.clone();
                    Score.ScoreResult s = Score.scoreArea(st.board, op.get("k").asDouble(), dead);
                    assertScore(op.get("r"), s, where);
                    assertEquals(op.get("own").asText(), intsString(s.owner()), () -> where.get() + " owner");
                    assertArrayEquals(ints(op.get("dd")), s.dead(), () -> where.get() + " dead");
                    assertArrayEquals(copy, dead, () -> where.get() + " 不应修改传入的 dead");
                }
                case "toggle" -> {
                    int[] dead = ints(op.get("dead"));
                    int[] copy = dead.clone();
                    int[] next = Score.toggleDead(st.board, dead, op.get("i").asInt());
                    assertArrayEquals(ints(op.get("r")), next, () -> where.get() + " toggleDead");
                    assertArrayEquals(copy, dead, () -> where.get() + " 不应修改传入的 dead");
                }
                case "text" -> {
                    Result res = resultOf(op.get("res"));
                    assertEquals(res, st.result, () -> where.get() + " result");
                    assertEquals(op.get("t").asText(), Record.resultText(st.result), () -> where.get() + " resultText");
                    assertEquals(op.get("l").asText(), Record.resultLabel(st.result), () -> where.get() + " resultLabel");
                    String sgf = Record.toSgf(st.size, st.komi, Record.movesOf(st), optText(op.get("pb")),
                            optText(op.get("pw")), st.result, optText(op.get("dt")));
                    assertEquals(op.get("sgf").asText(), sgf, () -> where.get() + " toSgf");
                }
                case "replay" -> checkReplay(size, st.komi, op, where);
                default -> fail("未知操作 " + o);
            }
            OPS.incrementAndGet();
        }
        assertEquals(g.get("cells").asText(), cellsString(st.board.cells), "game #" + gi + " 终局棋盘");
        GAMES.incrementAndGet();
    }

    private static String runGameOp(String o, JsonNode op, GameState st) {
        OpResult r;
        switch (o) {
            case "play" -> r = Game.play(st, op.get("i").asInt());
            case "pass" -> r = Game.pass(st);
            case "undo" -> {
                return String.valueOf(Game.undo(st));
            }
            case "resign" -> r = Game.resign(st, optInt(op.get("c")));
            case "resume" -> r = Game.resume(st);
            case "finish" -> r = Game.finish(st, resultOf(op.get("fin")));
            default -> throw new IllegalArgumentException(o);
        }
        if (r.ok()) assertNull(r.reason());
        return r.ok() ? "ok" : r.reason();
    }

    private static void checkReplay(int size, double komi, JsonNode op, Supplier<String> where) {
        int[] moves = ints(op.get("moves"));
        boolean auto = op.get("auto").asBoolean();
        if (op.has("err")) {
            JsonNode err = op.get("err");
            EngineException e = assertThrows(EngineException.class, () -> Record.replay(size, komi, moves, auto), where);
            assertEquals(err.get(0).asInt(), e.getMoveIndex(), () -> where.get() + " moveIndex");
            assertEquals(err.get(1).asText(), e.getReason(), () -> where.get() + " reason");
            assertEquals(err.get(2).asText(), e.getMessage(), () -> where.get() + " message");
        } else {
            GameState s = Record.replay(size, komi, moves, auto);
            assertEquals(op.get("cells").asText(), cellsString(s.board.cells), () -> where.get() + " replay board");
            assertState(op.get("s"), s, where);
            assertEquals(resultOf(op.get("res")), s.result, () -> where.get() + " replay result");
            assertEquals(op.get("mv").asInt(), Record.movesOf(s).length, where);
            assertEquals(auto, s.autoScore);
        }
    }

    // ---------- 独立检查 ----------

    @Test
    void coords() {
        List<String> failures = new ArrayList<>();
        for (JsonNode c : root.get("coords")) {
            String f = c.get("f").asText();
            int n = c.get("n").asInt();
            JsonNode a = c.get("a");
            Object actual;
            try {
                actual = switch (f) {
                    case "idxToGtp" -> Coords.idxToGtp(a.asInt(), n);
                    case "idxToSgf" -> Coords.idxToSgf(a.asInt(), n);
                    case "gtpToIdx" -> Coords.gtpToIdx(a.asText(), n);
                    case "sgfToIdx" -> Coords.sgfToIdx(a.asText(), n);
                    default -> throw new IllegalStateException(f);
                };
            } catch (IllegalArgumentException e) {
                actual = "<error>";
            }
            Object want = c.has("err") ? "<error>" : (c.get("v").isInt() ? (Object) c.get("v").asInt() : c.get("v").asText());
            if (!want.equals(actual)) failures.add(c + " → " + actual);
            STANDALONE.incrementAndGet();
        }
        assertTrue(failures.isEmpty(), () -> String.join("\n", failures));
    }

    @Test
    void resultTexts() {
        for (JsonNode c : root.get("texts")) {
            Result res = resultOf(c.get("res"));
            assertEquals(c.get("t").asText(), Record.resultText(res), c::toString);
            assertEquals(c.get("l").asText(), Record.resultLabel(res), c::toString);
            STANDALONE.incrementAndGet();
        }
    }

    @Test
    void sgfs() {
        for (JsonNode c : root.get("sgfs")) {
            String sgf = Record.toSgf(c.get("size").asInt(), c.get("komi").asDouble(), ints(c.get("moves")),
                    optText(c.get("pb")), optText(c.get("pw")), resultOf(c.get("res")), optText(c.get("dt")));
            assertEquals(c.get("sgf").asText(), sgf, c::toString);
            STANDALONE.incrementAndGet();
        }
    }
}
