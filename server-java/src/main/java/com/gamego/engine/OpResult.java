package com.gamego.engine;

/**
 * 对局操作的结果：成功为 {ok=true, reason=null}；失败时 reason 说明原因
 * （invalid / occupied / ko / suicide / scoring / ended / not-scoring）。
 */
public record OpResult(boolean ok, String reason) {

    public static final OpResult OK = new OpResult(true, null);

    public static OpResult fail(String reason) {
        return new OpResult(false, reason);
    }
}
