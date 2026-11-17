// Loads local env files without Node's "not found" notice for the ones that don't exist.
// Variables already in the environment win, then the earlier file in the list.
export const loadEnvFiles = (...paths: string[]): void => {
  for (const path of paths) {
    try {
      process.loadEnvFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
};
