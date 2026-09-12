/** Pure metrics: controller argument validation must not load Playwright. */
export const distribution = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { samples: values, median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null };
};
