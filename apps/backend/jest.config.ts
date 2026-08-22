/** Jest config for the backend. Pure-logic specs also run via node --test. */
export default {
  displayName: 'backend',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.spec.ts', '**/*.spec.ts'],
  transform: {
    '^.+\\.(ts|js)$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@aigov/shared-types$': '<rootDir>/../../libs/shared-types/src/index.ts',
    '^@aigov/database-client$': '<rootDir>/../../libs/database-client/src/index.ts',
    '^@aigov/utils$': '<rootDir>/../../libs/utils/src/index.ts',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.module.ts'],
};
