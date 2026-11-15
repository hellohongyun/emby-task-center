/** Runtime protection is independent of database SMTP configuration. */
export function isEmailDeliveryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.EMAIL_DELIVERY_DISABLED?.trim().toLowerCase() === "true" ||
    (env.NODE_ENV !== "production" && env.NODE_ENV !== "test")
  );
}
