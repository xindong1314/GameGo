package com.gamego.ai;

/** 对外（REST / 客户端）公开的难度：只有 id、名称、描述。 */
public record AiLevel(String id, String name, String desc) {}
