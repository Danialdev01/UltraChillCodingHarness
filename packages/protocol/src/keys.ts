/** What the server and the web app agree on about a project's saved keys. */

export const KEY_NAME_MAX = 200;
/** Long enough for a PEM private key or a service-account JSON. */
export const KEY_VALUE_MAX = 16_384;
export const KEY_TAG_MAX = 40;
export const KEY_TAGS_MAX = 20;
export const KEY_URL_MAX = 2_048;

/** A project key: what encrypts the project's environment variables in `.agent/env.val`. */
export const PROJECT_KEY_MIN = 8;
export const PROJECT_KEY_MAX = 1_024;
/** The most environment variables one project keeps. */
export const ENV_VARS_MAX = 500;
