package com.gamego.engine;

import static com.gamego.engine.Go.BLACK;

import java.util.ArrayList;
import java.util.List;

/**
 * 一局棋的状态（对应 JS createGame 返回的对象）。字段公开、可变，由 {@link Game} 的静态操作直接改写。
 * status 的三种取值：
 * <ul>
 *   <li>{@code playing} 正常行棋；</li>
 *   <li>{@code scoring} 仅在 autoScore 为 false 时出现：双方接连停一手后停在这里，由外部确认死子；</li>
 *   <li>{@code ended}   已有结果（自动数子、认输，或调用方通过 finish 给出）。</li>
 * </ul>
 */
public final class GameState {

    public static final String PLAYING = "playing";
    public static final String SCORING = "scoring";
    public static final String ENDED = "ended";

    public Board board;
    public int size;
    public double komi;
    public boolean autoScore;
    /** 轮到谁下：BLACK / WHITE */
    public int toPlay = BLACK;
    /** 当前劫点（不许落子的点），没有为 null */
    public Integer ko;
    public List<Move> history = new ArrayList<>();
    /** 提子数，按颜色下标：captures[BLACK]、captures[WHITE]（captures[0] 不用） */
    public int[] captures = new int[3];
    public int consecutivePasses;
    public String status = PLAYING;
    public Result result;

    public GameState(int size, double komi, boolean autoScore) {
        this.board = new Board(size);
        this.size = size;
        this.komi = komi;
        this.autoScore = autoScore;
    }
}
