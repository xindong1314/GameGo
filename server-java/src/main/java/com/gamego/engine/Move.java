package com.gamego.engine;

/**
 * history 中的一手。
 *
 * @param color        行棋方
 * @param idx          落点；null 表示停一手
 * @param captured     这手提掉的对方棋子（升序；停一手时为空数组）
 * @param koBefore     这手之前的劫点
 * @param koAfter      这手之后的劫点
 * @param passesBefore 这手之前的连续停一手次数（悔棋据此精确恢复）
 */
public record Move(int color, Integer idx, int[] captured, Integer koBefore, Integer koAfter, int passesBefore) {

    public boolean isPass() {
        return idx == null;
    }
}
