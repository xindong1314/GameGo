package com.gamego.engine;

/**
 * 重放着手序列时遇到非法着手（对应 JS 中带 moveIndex / reason 的 Error）。
 */
public class EngineException extends RuntimeException {

    private final int moveIndex;
    private final String reason;

    public EngineException(String message, int moveIndex, String reason) {
        super(message);
        this.moveIndex = moveIndex;
        this.reason = reason;
    }

    /** 出错着手在序列中的位置（从 0 数） */
    public int getMoveIndex() {
        return moveIndex;
    }

    /** 拒绝原因，如 occupied / ko / suicide / invalid */
    public String getReason() {
        return reason;
    }
}
