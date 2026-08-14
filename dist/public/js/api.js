/**
 * DearBackup - API Client & WebSockets Event Bus
 */

class ApiClient {
  constructor() {
    this.tokenKey = 'dearbackup_jwt_token';
    this.ws = null;
    this.wsListeners = new Map();
    this.isWsConnected = false;
    this.initWebSocket();
  }

  getToken() {
    return localStorage.getItem(this.tokenKey);
  }

  setToken(token) {
    if (token) {
      localStorage.setItem(this.tokenKey, token);
    } else {
      localStorage.removeItem(this.tokenKey);
    }
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };
    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  async request(endpoint, options = {}) {
    const url = `/api${endpoint}`;
    const config = {
      ...options,
      headers: {
        ...this.getHeaders(),
        ...(options.headers || {})
      }
    };

    try {
      const response = await fetch(url, config);
      if (response.status === 401 && !endpoint.includes('/auth/login') && !endpoint.includes('/auth/status')) {
        this.setToken(null);
        window.dispatchEvent(new CustomEvent('auth:unauthorized'));
        throw new Error('Sesión expirada');
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Error en la solicitud');
      }
      return data;
    } catch (err) {
      console.error(`API Error [${endpoint}]:`, err);
      throw err;
    }
  }

  get(endpoint) {
    return this.request(endpoint, { method: 'GET' });
  }

  post(endpoint, body) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  put(endpoint, body) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  }

  delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  }

  // =========================================================================
  // WebSockets Streaming
  // =========================================================================
  initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.isWsConnected = true;
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'log' && data.backupId) {
            const listeners = this.wsListeners.get(data.backupId) || [];
            listeners.forEach(cb => cb(data.log));
          }
        } catch (e) {
          console.error('Error parseando mensaje WS:', e);
        }
      };

      this.ws.onclose = () => {
        this.isWsConnected = false;
        // Auto reconectar en 3 segundos
        setTimeout(() => this.initWebSocket(), 3000);
      };
    } catch (e) {
      console.error('Error inicializando WebSocket:', e);
    }
  }

  subscribeLogs(backupId, callback) {
    if (!this.wsListeners.has(backupId)) {
      this.wsListeners.set(backupId, []);
    }
    this.wsListeners.get(backupId).push(callback);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe_logs', backupId }));
    }
  }
}

// Global API instance
window.API = new ApiClient();

// Toast Helper
window.showToast = function(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span> <div>${message}</div>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
};
