package com.gamego.db;

import java.util.function.Supplier;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 事务（对应 Node 版 repos.transaction(fn)）：最外层开启新事务，嵌套调用时用 SAVEPOINT（PROPAGATION_NESTED），
 * 内层失败只回滚内层；fn 抛出异常时回滚并原样抛出。
 *
 * <p>典型用法（终局结果与排位统计写进同一个事务，设计文档 6.5）：
 *
 * <pre>
 * db.transaction(() -> {
 *   games.finish(id, fields, now);
 *   if (counted) stats.applyRanked(id, winnerId, loserId, draw, List.of(black, white), now);
 *   return null;
 * });
 * </pre>
 */
@Component
public class DbTransactions {

  private final TransactionTemplate template;

  public DbTransactions(PlatformTransactionManager transactionManager) {
    this.template = new TransactionTemplate(transactionManager);
    this.template.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
  }

  /** 在事务中执行 fn 并返回其结果。 */
  public <T> T transaction(Supplier<T> fn) {
    if (fn == null) throw new IllegalArgumentException("transaction: 需要函数");
    return template.execute(status -> fn.get());
  }

  /** 在事务中执行 fn。 */
  public void run(Runnable fn) {
    if (fn == null) throw new IllegalArgumentException("transaction: 需要函数");
    template.executeWithoutResult(status -> fn.run());
  }
}
