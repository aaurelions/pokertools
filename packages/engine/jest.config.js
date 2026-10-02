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
          parser: {
            syntax: "typescript",
            tsx: false,
            decorators: true,
          },
        },
      },
    ],
  },

  collectCoverageFrom: ["src/**/*.ts"],
  coverageReporters: ["text", "json-summary", "lcov"],
  coverageThreshold: {
    global: {
      branches: 82,
      functions: 95,
      lines: 91,
      statements: 90,
    },
  },
};
