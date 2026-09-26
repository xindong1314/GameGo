package com.gamego.engine;

/**
 * 对局结果。winner：0 和棋/作废、1 黑、2 白；reason：score / resign / timeout / abort；
 * black / white 为双方点数（仅数子结果有，其余为 null）。
 */
public record Result(int winner, String reason, Double black, Double white) {

    /** 不带点数的结果（black / white 为 null） */
    public Result(int winner, String reason) {
        this(winner, reason, null, null);
    }
}
