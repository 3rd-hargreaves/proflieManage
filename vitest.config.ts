import { defineConfig } from 'vitest/config'

export default defineConfig({
    envDir: false,
    test: {
        environment: 'node',
        include: ['tests/save.test.ts', 'tests/uploadLimits.test.ts', 'tests/site*.test.ts', 'tests/cleanupJournal.test.ts'],
        restoreMocks: true,
        unstubEnvs: true,
    },
})
