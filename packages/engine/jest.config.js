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
  coverageThreshold: {
    global: {
      branches: 75, // Current: 76.05%
      functions: 85, // Current: 86.22%
      lines: 85, // Current: 87%
      statements: 85, // Current: 86.25%
    },
  },
};
