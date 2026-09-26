package com.gamego.config;

/**
 * KataGo 的三项配置（可执行文件、权重、分析引擎配置），均已解析为最终路径。
 * 三项都配置了才会有这个对象，见 {@link GameGoProperties#getKatago()}。
 */
public record KataGoSettings(String path, String model, String config) {}
