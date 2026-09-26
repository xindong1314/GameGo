package com.gamego.ws;

import com.gamego.ai.AiService;
import com.gamego.auth.AuthService;
import com.gamego.game.GameLoop;
import com.gamego.game.GameSettings;
import com.gamego.game.GameStore;
import com.gamego.game.Players;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

/**
 * WebSocket 配置：路径 /ws（握手时鉴权），单条消息 ≤ 16KB（超出由容器以 1009 关闭），任意来源（小程序没有同源限制）。
 * 同时注册 {@link Realtime}（也是 {@link com.gamego.api.ActiveGamesProvider}）。
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

  private final Realtime realtime;
  private final AuthService auth;

  public WebSocketConfig(Realtime realtime, AuthService auth) {
    this.realtime = realtime;
    this.auth = auth;
  }

  @Bean
  public static Realtime realtime(GameLoop gameLoop, GameStore gameStore, AiService aiService, GameSettings gameSettings) {
    return new Realtime(gameLoop, gameStore, aiService, gameSettings, Players.SECURE_RANDOM_INT);
  }

  @Override
  public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry
        .addHandler(new GameWebSocketHandler(realtime.sender()), "/ws")
        .addInterceptors(new WsHandshakeInterceptor(realtime, auth))
        .setAllowedOriginPatterns("*");
  }

  /** 单条消息上限（对应 Node 版 ws 的 maxPayload = 16KB）。 */
  @Bean
  public ServletServerContainerFactoryBean gameGoWebSocketContainer() {
    ServletServerContainerFactoryBean f = new ServletServerContainerFactoryBean();
    f.setMaxTextMessageBufferSize(Hub.MAX_PAYLOAD);
    f.setMaxBinaryMessageBufferSize(Hub.MAX_PAYLOAD);
    return f;
  }
}
