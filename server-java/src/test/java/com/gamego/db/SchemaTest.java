package com.gamego.db;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

/**
 * MySQL 建表脚本、H2 测试脚本、课程提交用 sql/gamego.sql 三者的表与列一致，并与 Node 版最新结构（迁移 1~3）相同。
 */
class SchemaTest {

  static final Map<String, List<String>> NODE_SCHEMA = new LinkedHashMap<>();

  static {
    NODE_SCHEMA.put("users", List.of("id", "openid", "nickname", "avatar", "created_at", "last_login_at"));
    NODE_SCHEMA.put("sessions", List.of("token", "user_id", "created_at", "expires_at"));
    NODE_SCHEMA.put("games", List.of("id", "mode", "size", "komi", "black_id", "white_id", "ai_level", "time_control",
        "status", "moves", "clocks", "dead", "winner", "reason", "score_black", "score_white", "result_text", "counted",
        "created_at", "updated_at", "ended_at", "state", "cause"));
    NODE_SCHEMA.put("user_stats", List.of("user_id", "games", "wins", "losses", "draws", "cur_streak", "max_streak",
        "cur_streak_at", "max_streak_at", "updated_at"));
  }

  static final List<String> NODE_INDEXES = List.of("games_ai_black", "games_ai_white", "games_black", "games_status",
      "games_white", "sessions_expires", "sessions_user");

  static Map<String, List<String>> columns(String sql) {
    Map<String, List<String>> out = new LinkedHashMap<>();
    Matcher t = Pattern.compile("CREATE TABLE IF NOT EXISTS (\\w+) \\((.*?)\\n\\)", Pattern.DOTALL).matcher(sql);
    while (t.find()) {
      List<String> cols = new ArrayList<>();
      for (String line : t.group(2).split("\\n")) {
        String l = line.trim();
        if (l.isEmpty() || l.startsWith("--")) continue;
        String first = l.split("\\s+")[0];
        if (List.of("PRIMARY", "KEY", "UNIQUE", "CONSTRAINT", "INDEX").contains(first)) continue;
        cols.add(first);
      }
      out.put(t.group(1), cols);
    }
    return out;
  }

  static List<String> indexes(String sql) {
    List<String> out = new ArrayList<>();
    Matcher m = Pattern.compile("(?:\\bKEY|CREATE INDEX IF NOT EXISTS) (\\w+) ").matcher(sql);
    while (m.find()) if (!m.group(1).equals("users_openid")) out.add(m.group(1));
    out.sort(String::compareTo);
    return out;
  }

  static String read(String cp) throws IOException {
    return new String(new ClassPathResource(cp).getInputStream().readAllBytes(), StandardCharsets.UTF_8);
  }

  @Test
  void schemasMatchNodeLatestSchema() throws IOException {
    String mysql = read("db/schema-mysql.sql");
    String h2 = read("db/schema-h2.sql");
    String submission = Files.readString(Path.of("sql", "gamego.sql"), StandardCharsets.UTF_8);
    assertThat(columns(mysql)).isEqualTo(NODE_SCHEMA);
    assertThat(columns(h2)).isEqualTo(NODE_SCHEMA);
    assertThat(columns(submission)).isEqualTo(NODE_SCHEMA);
    assertThat(indexes(mysql)).isEqualTo(NODE_INDEXES);
    assertThat(indexes(h2)).isEqualTo(NODE_INDEXES);
    assertThat(submission).contains("CREATE DATABASE IF NOT EXISTS gamego DEFAULT CHARACTER SET utf8mb4");
    assertThat(mysql).contains("ENGINE=InnoDB").contains("utf8mb4");
    // 课程提交的 SQL 文件与启动时执行的建表脚本，表定义部分完全相同
    String ddl = mysql.substring(mysql.indexOf("-- 用户"));
    assertThat(submission).endsWith(ddl);
  }
}
