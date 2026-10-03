export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Allow the Co-Authored-By trailer and wrapped prose without tripping length rules.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
