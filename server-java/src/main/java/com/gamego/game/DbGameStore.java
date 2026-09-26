package com.gamego.game;

import com.gamego.db.DbTransactions;
import com.gamego.db.GameFinish;
import com.gamego.db.GameProgress;
import com.gamego.db.GameRepository;
import com.gamego.db.GameRow;
import com.gamego.db.NewGame;
import com.gamego.db.RankedStats;
import com.gamego.db.StatsRepository;
import com.gamego.db.UnfinishedGame;
import com.gamego.db.User;
import com.gamego.db.UserRepository;
import java.util.List;

/** 基于数据库仓储的 {@link GameStore}（终局与排位统计在同一个 {@link DbTransactions} 事务里）。 */
public class DbGameStore implements GameStore {

  private final GameRepository games;
  private final StatsRepository stats;
  private final UserRepository users;
  private final DbTransactions db;

  public DbGameStore(GameRepository games, StatsRepository stats, UserRepository users, DbTransactions db) {
    this.games = games;
    this.stats = stats;
    this.users = users;
    this.db = db;
  }

  @Override
  public void insert(GameSession.InsertRow r) {
    NewGame g =
        new NewGame()
            .id(r.id())
            .mode(r.mode())
            .size(r.size())
            .komi(r.komi())
            .blackId(r.blackId())
            .whiteId(r.whiteId())
            .aiLevel(r.aiLevel())
            .timeControl(r.timeControl())
            .status(r.status())
            .moves(r.moves())
            .clocks(r.clocks())
            .counted(false)
            .createdAt(r.createdAt())
            .updatedAt(r.updatedAt());
    games.insert(g);
  }

  @Override
  public void saveProgress(String id, GameSession.Progress p, long now) {
    games.saveProgress(id, GameProgress.of().status(p.status()).moves(p.moves()).clocks(p.clocks()).state(p.state()), now);
  }

  @Override
  public GameRow findById(String id) {
    return games.findById(id);
  }

  @Override
  public List<UnfinishedGame> listUnfinished() {
    return games.listUnfinished();
  }

  @Override
  public boolean discard(String id) {
    return games.discard(id);
  }

  @Override
  public void finish(String id, GameSession.FinishFields f, RankedApply ranked, long now) {
    GameFinish gf =
        GameFinish.of(f.winner(), f.reason())
            .dead(f.dead())
            .scoreBlack(f.scoreBlack())
            .scoreWhite(f.scoreWhite())
            .resultText(f.resultText())
            .cause(f.cause());
    if (f.moves() != null) gf.moves(f.moves());
    db.run(() -> {
      games.finish(id, gf, now);
      if (ranked != null) {
        stats.applyRanked(ranked.gameId(), ranked.winnerId(), ranked.loserId(), ranked.draw(), ranked.userIds(), now);
      }
    });
  }

  @Override
  public boolean pairLimitReached(long a, long b, long now) {
    return stats.pairLimitReached(a, b, now);
  }

  @Override
  public RankedStats stats(long userId) {
    return stats.get(userId);
  }

  @Override
  public User findUser(long userId) {
    return users.findById(userId);
  }
}
