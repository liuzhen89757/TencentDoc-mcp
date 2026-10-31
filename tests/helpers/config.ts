import { loadConfig, type AppConfig } from "../../src/config.js";

/** 测试用配置：默认全部取内置默认值 + 假凭证 */
export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return loadConfig({
    env: {},
    overrides: {
      accessToken: "test-access-token",
      clientId: "test-client-id",
      openId: "test-open-id",
      ...overrides,
    },
  });
}
