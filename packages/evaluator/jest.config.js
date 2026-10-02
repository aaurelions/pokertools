module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js"],

  transform: {
    "^.+\\.(t|j)sx?$": [
      "@swc/jest",
      {
        jsc: {
          target: "es2022",
        },
      },
    ],
  },

  collectCoverageFrom: ["src/**/*.ts"],
  coverageReporters: ["text", "json-summary", "lcov"],
  coverageThreshold: {
    global: {
      branches: 95,
      functions: 99,
      lines: 99,
      statements: 98,
    },
  },
};
