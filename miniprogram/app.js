App({
  globalData: { token: '', user: null },
  setSession(token, user) {
    this.globalData.token = token;
    this.globalData.user = user;
  },
  clearSession() {
    this.globalData.token = '';
    this.globalData.user = null;
  }
});
