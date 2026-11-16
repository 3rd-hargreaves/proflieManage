import { defineConfig } from 'vitest/config'

export default defineConfig({
    envDir: false,
    test: {
        environment: 'node',
        include: ['tests/unit/services/*.test.ts', 'tests/unit/utils/limits.test.ts', 'tests/unit/utils/routes.test.ts', 'tests/unit/utils/draft.test.ts', 'tests/unit/utils/cleanup.test.ts'],
        restoreMocks: true,
        unstubEnvs: true,
    },
})
