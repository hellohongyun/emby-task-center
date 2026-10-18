<template>
  <main class="auth-splash" role="status" aria-live="polite">
    <img class="auth-splash__mark" src="/logo.svg" alt="" aria-hidden="true" />
    <span class="auth-splash__spinner" aria-hidden="true"></span>
    <p class="auth-splash__text">正在验证会话…</p>
  </main>
</template>

<style scoped>
.auth-splash {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  color: #edf2f4;
  background: #030b11;
}
.auth-splash__mark {
  width: 84px;
  height: 84px;
  display: block;
  object-fit: contain;
}
.auth-splash__spinner {
  width: 22px;
  height: 22px;
  border: 2px solid #21313b;
  border-top-color: #68bd68;
  border-radius: 50%;
  animation: auth-splash-spin 0.9s linear infinite;
}
.auth-splash__text {
  margin: 0;
  color: #93a0aa;
  font-size: 13px;
}
@keyframes auth-splash-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
