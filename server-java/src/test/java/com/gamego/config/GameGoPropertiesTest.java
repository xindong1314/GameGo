package com.gamego.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.context.properties.bind.BindException;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.PropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.ClassPathResource;

/** 配置（对应 Node 测试 config.test.js）：application.yml 把与 Node 版同名的环境变量绑定到 gamego.*。 */
class GameGoPropertiesTest {

  /** 模拟"只有这些环境变量"时加载 application.yml 并绑定、校验。 */
  static GameGoProperties load(Map<String, String> env) {
    StandardEnvironment e = new StandardEnvironment();
    e.getPropertySources().remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME);
    e.getPropertySources().remove(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME);
    try {
      for (PropertySource<?> ps : new YamlPropertySourceLoader().load("app", new ClassPathResource("application.yml"))) {
        e.getPropertySources().addLast(ps);
      }
    } catch (IOException ex) {
      throw new IllegalStateException(ex);
    }
    Map<String, Object> m = new HashMap<>(env);
    e.getPropertySources().addFirst(new MapPropertySource("env", m));
    GameGoProperties p = Binder.get(e).bindOrCreate("gamego", Bindable.of(GameGoProperties.class));
    p.afterPropertiesSet();
    return p;
  }

  static GameGoProperties load(String... kv) {
    Map<String, String> m = new HashMap<>();
    for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
    return load(m);
  }

  static void assertRejected(String... kv) {
    assertThatThrownBy(() -> load(kv)).as(String.join("=", kv)).isInstanceOfAny(ConfigError.class, BindException.class);
  }

  static String cwd(String... parts) {
    return Path.of(System.getProperty("user.dir"), parts).toAbsolutePath().normalize().toString();
  }

  @Test
  void defaultsMatchDesignSection25() {
    GameGoProperties c = load();
    assertThat(c.getPort()).isEqualTo(8080);
    assertThat(c.getHost()).isEqualTo("0.0.0.0");
    assertThat(c.getPublicBaseUrl()).isEqualTo("http://localhost:8080");
    assertThat(c.getDataDir()).isEqualTo(cwd("data"));
    assertThat(c.getAvatarDir()).isEqualTo(cwd("data", "avatars"));
    assertThat(c.getWx().getAppId()).isEmpty();
    assertThat(c.getWx().getSecret()).isEmpty();
    assertThat(c.isWxConfigured()).isFalse();
    assertThat(c.isDevLogin()).isFalse();
    assertThat(c.getSecCheck()).isEqualTo("on");
    assertThat(c.getKatago()).isNull();
    assertThat(c.isAiFallback()).isFalse();
    assertThat(c.getKomi()).isEqualTo(7.5);
    assertThat(c.getTimeControls()).isEqualTo(Map.of(
        9, new TimeControl(180000, 3, 20000), 13, new TimeControl(360000, 3, 30000), 19, new TimeControl(600000, 3, 30000)));
    assertThat(c.getMinMovesRanked()).isEqualTo(10);
    assertThat(c.getMinGamesWinrate()).isEqualTo(10);
    assertThat(c.getRankedPairDailyMax()).isEqualTo(3);
    assertThat(c.getFirstMoveTimeoutMs()).isEqualTo(60000);
    assertThat(c.getAbandonMs()).isEqualTo(90000);
    assertThat(c.getScoringTimeoutMs()).isEqualTo(180000);
    assertThat(c.getJudgeTimeoutMs()).isEqualTo(15000);
    assertThat(c.getAiIdleTimeoutMs()).isEqualTo(86400000);
    assertThat(c.getRoomTtlMs()).isEqualTo(1800000);
    assertThat(c.getLimits().getLoginBurst()).isEqualTo(30);
    assertThat(c.getLimits().getAvatarPerSec()).isEqualTo(1.0 / 12);
  }

  @Test
  void readsAllEnvVarsWithNodeNames() {
    GameGoProperties c = load(Map.ofEntries(
        Map.entry("PORT", "9000"),
        Map.entry("HOST", "127.0.0.1"),
        Map.entry("PUBLIC_BASE_URL", "https://go.example.com/"),
        Map.entry("DATA_DIR", "/srv/gamego/d"),
        Map.entry("WX_APPID", " wx123 "),
        Map.entry("WX_SECRET", "sec"),
        Map.entry("DEV_LOGIN", "1"),
        Map.entry("DEV_LOGIN_ALLOW_PRODUCTION", "1"),
        Map.entry("SEC_CHECK", "strict"),
        Map.entry("AI_FALLBACK", "true"),
        Map.entry("TC_9", "60,5,10"),
        Map.entry("TC_13", " 0 , 3 , 30 "),
        Map.entry("TC_19", "1200,0,0"),
        Map.entry("MIN_MOVES_RANKED", "0"),
        Map.entry("MIN_GAMES_WINRATE", "3"),
        Map.entry("RANKED_PAIR_DAILY_MAX", "0")));
    assertThat(c.getPort()).isEqualTo(9000);
    assertThat(c.getHost()).isEqualTo("127.0.0.1");
    assertThat(c.getPublicBaseUrl()).isEqualTo("https://go.example.com");
    assertThat(c.getDataDir()).isEqualTo(Path.of("/srv/gamego/d").toAbsolutePath().normalize().toString());
    assertThat(c.getAvatarDir()).isEqualTo(Path.of(c.getDataDir(), "avatars").toString());
    assertThat(c.getWx().getAppId()).isEqualTo("wx123");
    assertThat(c.getWx().getSecret()).isEqualTo("sec");
    assertThat(c.isWxConfigured()).isTrue();
    assertThat(c.isDevLogin()).isTrue();
    assertThat(c.getSecCheck()).isEqualTo("strict");
    assertThat(c.isAiFallback()).isTrue();
    assertThat(c.getTimeControls().get(9)).isEqualTo(new TimeControl(60000, 5, 10000));
    assertThat(c.getTimeControls().get(13)).isEqualTo(new TimeControl(0, 3, 30000));
    assertThat(c.getTimeControls().get(19)).isEqualTo(new TimeControl(1200000, 0, 0));
    assertThat(c.getMinMovesRanked()).isZero();
    assertThat(c.getMinGamesWinrate()).isEqualTo(3);
    assertThat(c.getRankedPairDailyMax()).as("0 = 同一对手不限局数").isZero();
  }

  @Test
  void relativePathsAndEmptyValues() {
    GameGoProperties c = load("DATA_DIR", "var/db", "PORT", "", "HOST", "  ", "DEV_LOGIN", "");
    assertThat(c.getDataDir()).isEqualTo(cwd("var", "db"));
    assertThat(c.getPort()).isEqualTo(8080);
    assertThat(c.getHost()).isEqualTo("0.0.0.0");
    assertThat(c.isDevLogin()).isFalse();
    assertThat(load("PUBLIC_BASE_URL", "https://a.com/sub/").getPublicBaseUrl()).isEqualTo("https://a.com/sub");
    assertThat(load("PUBLIC_BASE_URL", "http://192.168.1.100:8080").getPublicBaseUrl()).isEqualTo("http://192.168.1.100:8080");
    assertThat(load("PORT", "0").getPort()).isZero();
  }

  @Test
  void katagoNeedsAllThree() {
    assertThat(load("KATAGO_PATH", "/opt/katago/katago").getKatago()).isNull();
    assertThat(load("KATAGO_MODEL", "/opt/katago/m.bin.gz").getKatago()).isNull();
    KataGoSettings k = load("KATAGO_PATH", "/opt/katago/katago", "KATAGO_MODEL", "katago/m.bin.gz").getKatago();
    assertThat(k.path()).isEqualTo(Path.of("/opt/katago/katago").toAbsolutePath().normalize().toString());
    assertThat(k.model()).isEqualTo(cwd("katago", "m.bin.gz"));
    assertThat(k.config()).isEqualTo(cwd("katago", "analysis.cfg"));
    assertThat(load("KATAGO_PATH", "x/katago", "KATAGO_MODEL", "m", "KATAGO_CONFIG", "").getKatago().config())
        .isEqualTo(cwd("katago", "analysis.cfg"));
    // 裸命令名交给 PATH 查找，不做解析
    assertThat(load("KATAGO_PATH", "katago", "KATAGO_MODEL", "m").getKatago().path()).isEqualTo("katago");
    assertThat(load("KATAGO_PATH", "./katago/katago", "KATAGO_MODEL", "m").getKatago().path()).isEqualTo(cwd("katago", "katago"));
  }

  @Test
  void invalidValuesRejected() {
    List<String[]> bad = List.of(
        new String[] {"PORT", "abc"}, new String[] {"PORT", "70000"}, new String[] {"PORT", "-1"},
        new String[] {"PORT", "80.5"}, new String[] {"DEV_LOGIN", "maybe"}, new String[] {"AI_FALLBACK", "2"},
        new String[] {"PUBLIC_BASE_URL", "go.example.com"}, new String[] {"PUBLIC_BASE_URL", "ftp://go.example.com"},
        new String[] {"PUBLIC_BASE_URL", "https://go.example.com/?a=1"}, new String[] {"MIN_MOVES_RANKED", "-3"},
        new String[] {"MIN_GAMES_WINRATE", "0"}, new String[] {"MIN_GAMES_WINRATE", "ten"},
        new String[] {"RANKED_PAIR_DAILY_MAX", "-1"}, new String[] {"TC_9", "600,3"}, new String[] {"TC_9", "600,3,30,1"},
        new String[] {"TC_13", "a,b,c"}, new String[] {"TC_19", "600,-3,30"}, new String[] {"TC_19", "600,3,0"},
        new String[] {"TC_9", "0,0,0"}, new String[] {"TC_9", "1.5,3,30"}, new String[] {"TC_9", "100000,3,30"},
        new String[] {"SEC_CHECK", "maybe"});
    for (String[] kv : bad) assertRejected(kv);
  }

  @Test
  void devLoginRefusedInProductionUnlessAllowed() {
    assertThatThrownBy(() -> load("DEV_LOGIN", "1", "NODE_ENV", "production"))
        .isInstanceOf(ConfigError.class).hasMessageContaining("DEV_LOGIN_ALLOW_PRODUCTION");
    assertThatThrownBy(() -> load("DEV_LOGIN", "1", "PUBLIC_BASE_URL", "https://go.example.com"))
        .isInstanceOf(ConfigError.class);
    assertThat(load("DEV_LOGIN", "1", "NODE_ENV", "production", "DEV_LOGIN_ALLOW_PRODUCTION", "1").isDevLogin()).isTrue();
    assertThat(load("DEV_LOGIN", "1", "PUBLIC_BASE_URL", "http://192.168.1.100:8080").isDevLogin()).isTrue();
    assertThat(load("NODE_ENV", "production", "PUBLIC_BASE_URL", "https://go.example.com").isDevLogin()).isFalse();
  }

  @Configuration
  @EnableConfigurationProperties(GameGoProperties.class)
  static class PropsOnly {}

  @Test
  void applicationRefusesToStartWithDevLoginOnHttps() {
    new ApplicationContextRunner()
        .withUserConfiguration(PropsOnly.class)
        .withPropertyValues("gamego.dev-login=true", "gamego.public-base-url=https://go.example.com")
        .run(ctx -> {
          assertThat(ctx).hasFailed();
          Throwable t = ctx.getStartupFailure();
          while (t.getCause() != null && !(t instanceof ConfigError)) t = t.getCause();
          assertThat(t).isInstanceOf(ConfigError.class);
        });
    new ApplicationContextRunner()
        .withUserConfiguration(PropsOnly.class)
        .withPropertyValues("gamego.dev-login=true", "gamego.public-base-url=http://localhost:8080")
        .run(ctx -> assertThat(ctx).hasNotFailed());
  }

  @Test
  void secCheckModesAndBooleans() {
    assertThat(load().getSecCheck()).isEqualTo("on");
    assertThat(load("SEC_CHECK", "OFF").getSecCheck()).isEqualTo("off");
    assertThat(load("SEC_CHECK", "0").getSecCheck()).isEqualTo("off");
    assertThat(load("SEC_CHECK", "1").getSecCheck()).isEqualTo("on");
    assertThat(load("SEC_CHECK", "strict").getSecCheck()).isEqualTo("strict");
    for (String v : List.of("1", "true", "TRUE", "yes", "on")) assertThat(load("DEV_LOGIN", v).isDevLogin()).as(v).isTrue();
    for (String v : List.of("0", "false", "no", "off")) assertThat(load("DEV_LOGIN", v).isDevLogin()).as(v).isFalse();
  }

  @Test
  void quotedValuesLikeNodeEnvFile() {
    GameGoProperties c = load("TC_9", "\"120,3,10\"", "WX_APPID", "'fromfile'", "PUBLIC_BASE_URL", "\"http://a.com/\"");
    assertThat(c.getTimeControls().get(9)).isEqualTo(new TimeControl(120000, 3, 10000));
    assertThat(c.getWx().getAppId()).isEqualTo("fromfile");
    assertThat(c.getPublicBaseUrl()).isEqualTo("http://a.com");
  }

  @Test
  void parseTimeControl() {
    assertThat(TimeControl.parse("600,3,30", "TC")).isEqualTo(new TimeControl(600000, 3, 30000));
    assertThat(TimeControl.parse("0,5,10", "TC")).isEqualTo(new TimeControl(0, 5, 10000));
    assertThatThrownBy(() -> TimeControl.parse("", "TC")).isInstanceOf(ConfigError.class).hasMessageContaining("TC");
  }
}
