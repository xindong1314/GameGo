package com.gamego.game;

import com.gamego.db.GameRow;
import com.gamego.db.RankedStats;
import com.gamego.db.UnfinishedGame;
import com.gamego.db.User;
import java.util.List;

/**
 * 对局模块用到的持久化操作（对应 Node 版 manager 用到的 repos.games / repos.stats / repos.users / repos.transaction）。
 * 生产实现 {@link DbGameStore}；测试用内存实现（可注入失败）。只在游戏循环线程上调用。
 */
public interface GameStore {

  /** 排位赛计入统计的参数（对应 applyRanked({ gameId, winnerId, loserId, draw, userIds })）。 */
  record RankedApply(String gameId, Long winnerId, Long loserId, boolean draw, List<Long> userIds) {}

  /** games.insert。 */
  void insert(GameSession.InsertRow row);

  /** games.saveProgress（已结束的对局不会被改回）。 */
  void saveProgress(String id, GameSession.Progress p, long now);

  /** games.findById；不存在返回 null。 */
  GameRow findById(String id);

  /** 未结束的对局（重启恢复用）；解析不了的行以 broken 项返回。 */
  List<UnfinishedGame> listUnfinished();

  /** 删除一局未结束的对局；返回是否删除。 */
  boolean discard(String id);

  /**
   * 终局：games.finish 与（ranked 不为 null 时）stats.applyRanked 在同一个事务里执行，失败整体回滚并抛出异常。
   * f.moves() 为 null 时不写着手序列（作废损坏记录时）。
   */
  void finish(String id, GameSession.FinishFields f, RankedApply ranked, long now);

  /** 同一对手 24 小时内计入排行的局数已达上限（RANKED_PAIR_DAILY_MAX，0 = 不限）。 */
  boolean pairLimitReached(long a, long b, long now);

  /** 排位统计（不存在时全 0）。 */
  RankedStats stats(long userId);

  /** 用户；不存在返回 null。 */
  User findUser(long userId);
}
