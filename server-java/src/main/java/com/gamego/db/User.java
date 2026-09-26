package com.gamego.db;

/**
 * 用户（设计文档 3.1）：{@code { id, openid, nickname, avatar, createdAt, lastLoginAt }}。
 * avatar 为头像文件名（不含域名），空串表示没有头像。对外只暴露 {@code { id, nickname, avatarUrl }}，
 * 见 {@link com.gamego.api.PublicUsers}。
 */
public record User(long id, String openid, String nickname, String avatar, long createdAt, long lastLoginAt) {}
