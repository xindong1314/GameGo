package com.gamego;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/** 围棋小程序服务端（Java 版）入口。接口与 Node.js 版（server/）一致，同一个小程序可以连接任一版本。 */
@SpringBootApplication
public class GameGoApplication {
  public static void main(String[] args) {
    SpringApplication.run(GameGoApplication.class, args);
  }
}
