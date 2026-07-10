// On Vercel, set this to the public HTTPS URL of the Render service.
// Leave it empty only when frontend and backend are served by the same server.
const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);

window.APP_CONFIG = {
  apiBaseUrl: isLocal ? "" : "https://sitomatrimonio.onrender.com",
};
