package com.gamego.config;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.apache.catalina.connector.Connector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 注册 {@link GameGoProperties}、启动时创建数据目录，并调整内嵌 Tomcat。 */
@Configuration
@EnableConfigurationProperties(GameGoProperties.class)
public class GameGoConfiguration {

  private static final Logger log = LoggerFactory.getLogger(GameGoConfiguration.class);

  /** 启动时创建数据目录与头像目录（对应 Node 版 ensureDirs）。 */
  @Bean
  public DataDirs gameGoDataDirs(GameGoProperties props) {
    Path avatars = Path.of(props.getAvatarDir());
    try {
      Files.createDirectories(avatars);
    } catch (IOException e) {
      throw new UncheckedIOException("无法创建头像目录 " + avatars, e);
    }
    log.info("数据目录 {}，头像目录 {}，对外地址 {}", props.getDataDir(), avatars, props.getPublicBaseUrl());
    if (props.isDevLogin()) log.warn("已开启开发登录（DEV_LOGIN=1），只能用于本地开发！");
    return new DataDirs(props.getDataDir(), avatars.toString());
  }

  /**
   * 路径里编码过的斜杠（%2F）原样交给应用（Tomcat 默认直接回 400）：
   * /avatars/..%2Fx.png 这类请求由头像接口的严格文件名规则拒绝（404），与 Node 版一致。
   */
  @Bean
  public WebServerFactoryCustomizer<TomcatServletWebServerFactory> gameGoTomcatCustomizer() {
    return factory -> factory.addConnectorCustomizers((Connector c) -> c.setEncodedSolidusHandling("passthrough"));
  }

  /** 启动时确定的数据目录与头像目录（绝对路径）。 */
  public record DataDirs(String dataDir, String avatarDir) {}
}
