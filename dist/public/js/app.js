/**
 * DearBackup - Frontend Application Logic
 */

document.addEventListener('DOMContentLoaded', () => {
  // Vistas principales
  const setupView = document.getElementById('setup-view');
  const loginView = document.getElementById('login-view');
  const appView = document.getElementById('app-view');

  // Formularios de Login
  const loginForm = document.getElementById('login-form');
  const login2FAForm = document.getElementById('login-2fa-form');

  // Modales
  const clientModal = document.getElementById('client-modal');
  const terminalModal = document.getElementById('terminal-modal');
  const sshKeyModal = document.getElementById('ssh-key-modal');
  const shareLinkModal = document.getElementById('share-link-modal');
  const modal2FA = document.getElementById('modal-2fa');
  const modalRegisterPasskey = document.getElementById('modal-register-passkey');
  const modalSMTPTester = document.getElementById('modal-smtp-tester');

  // Estado global
  let currentClients = [];
  let current2FASetupSecret = '';

  const { startRegistration, startAuthentication } = window.SimpleWebAuthnBrowser || {};

  // =========================================================================
  // 1. INICIALIZACIÓN & ESTADO DE SESIÓN
  // =========================================================================
  async function checkAuthStatus() {
    try {
      const status = await API.get('/auth/status');

      if (!status.initialized) {
        setupView.classList.remove('hidden');
        loginView.classList.add('hidden');
        appView.classList.add('hidden');
        return;
      }

      const passkeyBtnContainer = document.getElementById('passkey-login-container');
      if (passkeyBtnContainer) {
        if (status.hasPasskeys) {
          passkeyBtnContainer.classList.remove('hidden');
        } else {
          passkeyBtnContainer.classList.add('hidden');
        }
      }

      const token = API.getToken();
      if (!token) {
        setupView.classList.add('hidden');
        loginView.classList.remove('hidden');
        appView.classList.add('hidden');
        loginForm.classList.remove('hidden');
        login2FAForm.classList.add('hidden');
        return;
      }

      try {
        const me = await API.get('/auth/me');
        setupView.classList.add('hidden');
        loginView.classList.add('hidden');
        appView.classList.remove('hidden');

        updateVaultStatus(me.vaultUnlocked);
        loadDashboard();
      } catch (err) {
        API.setToken(null);
        loginView.classList.remove('hidden');
        appView.classList.add('hidden');
      }
    } catch (err) {
      showToast('Error conectando con el servidor de DearBackup', 'error');
    }
  }

  function updateVaultStatus(isUnlocked) {
    const box = document.getElementById('vault-status-box');
    const label = document.getElementById('vault-status-text');
    if (isUnlocked) {
      box.querySelector('.status-dot').style.backgroundColor = 'var(--accent-green)';
      box.querySelector('.status-dot').style.boxShadow = '0 0 8px var(--accent-green)';
      label.textContent = 'Activo & Desbloqueado';
    } else {
      box.querySelector('.status-dot').style.backgroundColor = 'var(--accent-amber)';
      box.querySelector('.status-dot').style.boxShadow = '0 0 8px var(--accent-amber)';
      label.textContent = 'Bloqueado (Clic para abrir)';
    }
  }

  // Modal de desbloqueo rápido del Vault
  const vaultUnlockModal = document.getElementById('vault-unlock-modal');
  const vaultStatusBox = document.getElementById('vault-status-box');
  const vaultUnlockForm = document.getElementById('vault-unlock-form');

  if (vaultStatusBox) {
    vaultStatusBox.addEventListener('click', () => {
      vaultUnlockModal.classList.remove('hidden');
      document.getElementById('vault-unlock-phrase').value = '';
      document.getElementById('vault-unlock-phrase').focus();
    });
  }

  document.getElementById('vault-unlock-modal-close')?.addEventListener('click', () => {
    vaultUnlockModal.classList.add('hidden');
  });
  document.getElementById('btn-cancel-vault-unlock')?.addEventListener('click', () => {
    vaultUnlockModal.classList.add('hidden');
  });

  vaultUnlockForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-submit-vault-unlock');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Desbloqueando...</span>';

    try {
      const phrase = document.getElementById('vault-unlock-phrase').value;
      const remember = document.getElementById('vault-unlock-remember').checked;

      const res = await API.post('/auth/unlock-vault', { masterKeyPhrase: phrase, remember });
      updateVaultStatus(true);
      vaultUnlockModal.classList.add('hidden');
      showToast(res.message || '¡Vault desbloqueado con éxito!', 'success');
      loadClients();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  });

  window.addEventListener('auth:unauthorized', () => {
    loginView.classList.remove('hidden');
    appView.classList.add('hidden');
    showToast('Tu sesión ha expirado. Por favor inicia sesión nuevamente.', 'error');
  });

  // Alternar formularios en Setup Wizard (Manual, Restauración de BD y Paquete .dearconfig)
  const btnToggleSetupImport = document.getElementById('btn-toggle-setup-import');
  const btnToggleSetupRestoreDb = document.getElementById('btn-toggle-setup-restore-db');
  const setupForm = document.getElementById('setup-form');
  const setupImportForm = document.getElementById('setup-import-form');
  const setupRestoreDbForm = document.getElementById('setup-restore-db-form');

  const showSetupForm = (targetForm) => {
    if (setupForm) setupForm.classList.add('hidden');
    if (setupImportForm) setupImportForm.classList.add('hidden');
    if (setupRestoreDbForm) setupRestoreDbForm.classList.add('hidden');
    if (targetForm) targetForm.classList.remove('hidden');
  };

  if (btnToggleSetupImport) {
    btnToggleSetupImport.addEventListener('click', () => showSetupForm(setupImportForm));
  }

  if (btnToggleSetupRestoreDb) {
    btnToggleSetupRestoreDb.addEventListener('click', () => showSetupForm(setupRestoreDbForm));
  }

  document.querySelectorAll('.btn-back-to-setup-manual').forEach(btn => {
    btn.addEventListener('click', () => showSetupForm(setupForm));
  });

  // 1.1 Restaurar Base de Datos Física (.db / .sqlite / .tar.gz) en Setup Wizard
  if (setupRestoreDbForm) {
    setupRestoreDbForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('setup-restore-db-file');
      if (!fileInput.files || fileInput.files.length === 0) {
        return showToast('Por favor selecciona un archivo .db o .tar.gz', 'error');
      }

      const btn = document.getElementById('setup-restore-db-submit-btn');
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span>⏳ Restaurando base de datos...</span>';

      const file = fileInput.files[0];
      const reader = new FileReader();

      reader.onload = async (event) => {
        try {
          const arrayBuffer = event.target.result;
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          const len = bytes.byteLength;
          for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);

          const payload = {
            dbBase64: base64,
            newAdminPassword: document.getElementById('setup-restore-db-password')?.value || undefined,
            vaultPassphrase: document.getElementById('setup-restore-db-vault-phrase')?.value || undefined
          };

          const res = await API.post('/auth/restore-database-setup', payload);
          if (res.token) {
            API.setToken(res.token);
          }
          showToast(res.message, 'success');
          setTimeout(() => {
            checkAuthStatus();
          }, 1000);
        } catch (err) {
          showToast(`Error al restaurar: ${err.message}`, 'error');
        } finally {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      };

      reader.onerror = () => {
        btn.disabled = false;
        btn.innerHTML = originalText;
        showToast('Error al leer el archivo de base de datos', 'error');
      };

      reader.readAsArrayBuffer(file);
    });
  }

  // 1.2 Importar Paquete de Configuración (.dearconfig) en Setup Wizard
  if (setupImportForm) {
    setupImportForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('setup-import-file');
      if (!fileInput.files || fileInput.files.length === 0) {
        return showToast('Por favor selecciona un archivo .dearconfig', 'error');
      }

      const btn = document.getElementById('setup-import-submit-btn');
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span>⏳ Importando y configurando...</span>';

      const file = fileInput.files[0];
      const reader = new FileReader();

      reader.onload = async (event) => {
        try {
          const fileContent = event.target.result;
          const payload = {
            packageData: fileContent,
            packagePassphrase: document.getElementById('setup-import-pkg-pass').value,
            username: document.getElementById('setup-import-username').value.trim(),
            password: document.getElementById('setup-import-password').value
          };

          const res = await API.post('/auth/import-setup', payload);
          API.setToken(res.token);
          showToast(res.message, 'success');
          checkAuthStatus();
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      };

      reader.onerror = () => {
        btn.disabled = false;
        btn.innerHTML = originalText;
        showToast('Error al leer el archivo seleccionado', 'error');
      };

      reader.readAsText(file);
    });
  }

  // Botón de Ayuda en Login para Recuperar Credenciales
  const btnLoginRecoveryHint = document.getElementById('btn-show-login-recovery-hint');
  if (btnLoginRecoveryHint) {
    btnLoginRecoveryHint.addEventListener('click', (e) => {
      e.preventDefault();
      alert(
        '🛡️ AYUDA PARA RECUPERAR ACCESO:\n\n' +
        '1. Si restauraste un respaldo de otra máquina, el usuario suele ser el que tenías originalmente (por ejemplo: "brianv", en vez de "admin").\n\n' +
        '2. Para ver tus usuarios o cambiar tu contraseña al instante, abre una terminal en tu laptop y ejecuta:\n' +
        '   npm run recovery\n\n' +
        '3. Selecciona la Opción 2 ("Restablecer Contraseña de Administrador") y define tu nueva contraseña.'
      );
    });
  }

  // =========================================================================
  // 2. SETUP WIZARD & LOGIN FORMS
  // =========================================================================
  document.getElementById('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('setup-submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Inicializando...</span>';

    try {
      const username = document.getElementById('setup-username').value;
      const password = document.getElementById('setup-password').value;
      const masterKeyPhrase = document.getElementById('setup-vault-phrase').value;

      const res = await API.post('/auth/setup', { username, password, masterKeyPhrase });
      API.setToken(res.token);
      showToast('¡Plataforma inicializada con éxito!', 'success');
      checkAuthStatus();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span>🚀 Inicializar Plataforma & Vault</span>';
    }
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Verificando...</span>';

    try {
      const username = document.getElementById('login-username').value;
      const password = document.getElementById('login-password').value;
      const masterKeyPhrase = document.getElementById('login-vault-phrase').value;

      const res = await API.post('/auth/login', { username, password, masterKeyPhrase });

      if (res.require2FA) {
        document.getElementById('login-2fa-temp-token').value = res.tempToken;
        loginForm.classList.add('hidden');
        login2FAForm.classList.remove('hidden');
        document.getElementById('login-2fa-code').focus();
        showToast('Ingresa tu código de autenticador 2FA', 'info');
        return;
      }

      API.setToken(res.token);
      showToast('Inicio de sesión correcto', 'success');
      checkAuthStatus();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span>🔐 Iniciar Sesión</span>';
    }
  });

  login2FAForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-2fa-submit-btn');
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Validando 2FA...</span>';

    try {
      const tempToken = document.getElementById('login-2fa-temp-token').value;
      const code = document.getElementById('login-2fa-code').value;
      const masterKeyPhrase = document.getElementById('login-vault-phrase').value;

      const res = await API.post('/auth/login-2fa', { tempToken, code, masterKeyPhrase });
      API.setToken(res.token);
      showToast('¡Autenticación 2FA exitosa!', 'success');
      checkAuthStatus();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span>✅ Validar Código 2FA</span>';
    }
  });

  document.getElementById('btn-cancel-2fa-login').addEventListener('click', () => {
    login2FAForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
  });

  document.getElementById('btn-login-passkey').addEventListener('click', async () => {
    const btn = document.getElementById('btn-login-passkey');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>👆 Toca tu sensor biométrico / llave...</span>';

    try {
      const options = await API.post('/auth/passkey/auth-options', {});

      let authResponse;
      if (startAuthentication) {
        authResponse = await startAuthentication(options);
      } else {
        throw new Error('La API de Passkeys WebAuthn no está soportada en este navegador.');
      }

      const masterKeyPhrase = document.getElementById('login-vault-phrase').value;
      const res = await API.post('/auth/passkey/auth-verify', {
        response: authResponse,
        masterKeyPhrase
      });

      if (res.success) {
        API.setToken(res.token);
        showToast(res.message, 'success');
        checkAuthStatus();
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  });

  document.getElementById('logout-btn').addEventListener('click', () => {
    API.setToken(null);
    showToast('Sesión cerrada');
    checkAuthStatus();
  });

  // =========================================================================
  // 3. NAVEGACIÓN ENTRE VISTAS
  // =========================================================================
  const navLinks = document.querySelectorAll('.nav-link');
  const sections = document.querySelectorAll('.content-section');

  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      const targetView = link.dataset.view;
      
      navLinks.forEach(n => n.classList.remove('active'));
      link.classList.add('active');

      sections.forEach(s => s.classList.remove('active'));
      const activeSec = document.getElementById(`view-${targetView}`);
      if (activeSec) activeSec.classList.add('active');

      if (targetView === 'dashboard') {
        document.getElementById('page-title').textContent = 'Panel de Control';
        document.getElementById('page-subtitle').textContent = 'Supervisión y métricas generales de respaldos';
        loadDashboard();
      } else if (targetView === 'clients') {
        document.getElementById('page-title').textContent = 'Clientes & Servidores';
        document.getElementById('page-subtitle').textContent = 'Gestión de servidores remotos, bases de datos y DTEs';
        loadClients();
      } else if (targetView === 'backups') {
        document.getElementById('page-title').textContent = 'Respaldos & Historial';
        document.getElementById('page-subtitle').textContent = 'Registro de ejecuciones, descargas y enlaces seguros';
        loadBackupsHistory();
      } else if (targetView === 'security') {
        document.getElementById('page-title').textContent = 'Seguridad & Llaves';
        document.getElementById('page-subtitle').textContent = 'Frase del Vault, Contraseña, Passkeys y 2FA';
        loadSecurityView();
      } else if (targetView === 'settings') {
        document.getElementById('page-title').textContent = 'Configuración Global';
        document.getElementById('page-subtitle').textContent = 'Ajustes de alertas SMTP, Telegram y Almacenamiento Cloud';
        loadSettings();
      }
    });
  });

  // =========================================================================
  // 4. VISTA: DASHBOARD
  // =========================================================================
  async function loadDashboard() {
    try {
      const stats = await API.get('/stats/dashboard');

      document.getElementById('stat-total-clients').textContent = stats.clients.total;
      document.getElementById('stat-active-clients').textContent = `${stats.clients.active} activos`;
      document.getElementById('stat-success-backups').textContent = stats.backups.success;
      document.getElementById('stat-success-rate').textContent = `${stats.backups.successRate}% efectividad`;
      document.getElementById('stat-storage-used').textContent = Number(stats.storage.totalMB) > 1024 ? `${stats.storage.totalGB} GB` : `${stats.storage.totalMB} MB`;
      document.getElementById('stat-running-backups').textContent = stats.backups.running;
      document.getElementById('stat-failed-backups').textContent = `${stats.backups.failed} fallos registrados`;

      // Métricas de Almacenamiento Local (Disco Host)
      if (stats.storage.local) {
        const local = stats.storage.local;
        const displayBackups = Number(local.backupsMB) > 1024 ? `${local.backupsGB} GB` : `${local.backupsMB} MB`;
        const elBackups = document.getElementById('dash-local-backups-size');
        const elFree = document.getElementById('dash-local-free-size');
        const elTotal = document.getElementById('dash-local-total-size');
        const elProgress = document.getElementById('dash-local-progress-bar');
        const elBadge = document.getElementById('dash-local-percent-badge');

        if (elBackups) elBackups.textContent = displayBackups;
        if (elFree) elFree.textContent = Number(local.diskFreeGB) > 0 ? `${local.diskFreeGB} GB disponibles` : 'Disponible';
        if (elTotal) elTotal.textContent = Number(local.diskTotalGB) > 0 ? `${local.diskTotalGB} GB` : '--';
        if (elProgress) {
          const pct = Math.max(2, Math.min(100, local.diskUsagePercent || (local.diskTotalBytes > 0 ? Math.round((local.diskUsedBytes / local.diskTotalBytes) * 100) : 10)));
          elProgress.style.width = `${pct}%`;
          if (pct > 85) {
            elProgress.style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
          } else {
            elProgress.style.background = 'linear-gradient(90deg, #38bdf8, #3b82f6)';
          }
        }
        if (elBadge) elBadge.textContent = `${local.diskUsagePercent || 0}% Ocupado`;
      }

      // Métricas de Almacenamiento en la Nube (Cloudflare R2 / S3)
      if (stats.storage.cloud) {
        const cloud = stats.storage.cloud;
        const displayUsed = Number(cloud.usedMB) > 1024 ? `${cloud.usedGB} GB` : `${cloud.usedMB} MB`;
        const elUsed = document.getElementById('dash-cloud-used-size');
        const elRemaining = document.getElementById('dash-cloud-remaining-size');
        const elMax = document.getElementById('dash-cloud-max-size');
        const elProgress = document.getElementById('dash-cloud-progress-bar');
        const elBadge = document.getElementById('dash-cloud-percent-badge');

        if (elUsed) elUsed.textContent = displayUsed;
        if (elRemaining) elRemaining.textContent = `${cloud.remainingGB} GB libres`;
        if (elMax) elMax.textContent = `${cloud.maxStorageGB} GB`;
        if (elProgress) {
          const pct = Math.max(cloud.usedBytes > 0 ? 3 : 0, Math.min(100, cloud.usagePercent || 0));
          elProgress.style.width = `${pct}%`;
          if (pct > 85) {
            elProgress.style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
          } else {
            elProgress.style.background = 'linear-gradient(90deg, #10b981, #059669)';
          }
        }
        if (elBadge) {
          elBadge.textContent = cloud.enabled ? `${cloud.usagePercent}% de Cuota` : 'Cloud Inactivo';
          elBadge.className = cloud.enabled ? 'badge badge-success' : 'badge badge-outline';
        }
      }

      // Métricas de Memoria RAM & Salud del Docker
      if (stats.system) {
        const sys = stats.system;
        const elRamUsed = document.getElementById('dash-ram-used-mb');
        const elRamFree = document.getElementById('dash-ram-free-host');
        const elUptime = document.getElementById('dash-system-uptime');
        const elProgress = document.getElementById('dash-ram-progress-bar');
        const elBadge = document.getElementById('dash-ram-health-badge');

        if (elRamUsed) {
          const usedMB = Number(sys.processRssMB) || 0;
          elRamUsed.textContent = usedMB >= 1024 ? `${(usedMB / 1024).toFixed(2)} GB` : `${usedMB} MB`;
        }
        if (elRamFree) {
          const freeGB = (sys.systemFreeMemMB / 1024).toFixed(1);
          elRamFree.textContent = Number(freeGB) > 1 ? `${freeGB} GB` : `${sys.systemFreeMemMB} MB`;
        }

        if (elUptime) {
          const sec = sys.uptimeSeconds || 0;
          const hours = Math.floor(sec / 3600);
          const mins = Math.floor((sec % 3600) / 60);
          if (hours > 24) {
            const days = Math.floor(hours / 24);
            elUptime.textContent = `${days}d ${hours % 24}h`;
          } else if (hours > 0) {
            elUptime.textContent = `${hours}h ${mins}m`;
          } else {
            elUptime.textContent = `${mins} min`;
          }
        }

        if (elProgress) {
          const usedMB = Number(sys.processRssMB) || 0;
          const ramPct = Math.max(3, Math.min(100, Math.round((usedMB / 1024) * 100)));
          elProgress.style.width = `${ramPct}%`;
          if (usedMB > 500) {
            elProgress.style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
          } else {
            elProgress.style.background = 'linear-gradient(90deg, #a855f7, #6366f1)';
          }
        }

        if (elBadge) {
          if (sys.processRssMB < 120) {
            elBadge.textContent = '🟢 Ultraligero';
            elBadge.className = 'badge badge-success';
          } else if (sys.processRssMB < 300) {
            elBadge.textContent = '🟡 Normal';
            elBadge.className = 'badge badge-warning';
          } else {
            elBadge.textContent = '🔴 Alto';
            elBadge.className = 'badge badge-danger';
          }
        }
      }

      const tbody = document.getElementById('dashboard-recent-tbody');
      if (stats.recentLogs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-muted">Aún no se han ejecutado respaldos. ¡Configura tu primer cliente!</td></tr>';
        return;
      }

      tbody.innerHTML = stats.recentLogs.map(log => {
        const statusClass = log.status === 'success' ? 'success' : log.status === 'failed' ? 'failed' : 'running';
        const statusText = log.status === 'success' ? 'Exitoso' : log.status === 'failed' ? 'Fallido' : 'En proceso';
        const dateFormatted = new Date(log.start_time).toLocaleString();
        const sizeMB = (log.file_size_bytes / (1024 * 1024)).toFixed(2);

        return `
          <tr>
            <td><span class="status-pill ${statusClass}">${statusText}</span></td>
            <td><strong>${log.client_name}</strong></td>
            <td>${dateFormatted}</td>
            <td>${log.duration_seconds}s</td>
            <td>${log.status === 'success' ? `${sizeMB} MB` : '-'}</td>
            <td>
              <span class="badge">Local</span>
              ${log.is_replicated_cloud ? '<span class="badge" style="background: rgba(139, 92, 246, 0.2); color: var(--accent-purple);">Cloud S3</span>' : ''}
            </td>
            <td>
              <button class="btn btn-sm btn-outline btn-view-log" data-log-id="${log.id}">📜 Logs</button>
            </td>
          </tr>
        `;
      }).join('');

      tbody.querySelectorAll('.btn-view-log').forEach(btn => {
        btn.addEventListener('click', () => viewLogDetails(btn.dataset.logId));
      });

    } catch (err) {
      showToast('Error cargando métricas del dashboard', 'error');
    }
  }

  document.getElementById('refresh-dashboard-btn').addEventListener('click', loadDashboard);

  // =========================================================================
  // 5. VISTA: SEGURIDAD & PASSKEYS & FRASE DEL VAULT
  // =========================================================================
  async function loadSecurityView() {
    try {
      const me = await API.get('/auth/me');
      const badge = document.getElementById('2fa-badge');
      const btnSetup2FA = document.getElementById('btn-setup-2fa');
      const btnDisable2FA = document.getElementById('btn-disable-2fa');

      if (me.user.twoFactorEnabled) {
        badge.className = 'badge badge-green';
        badge.textContent = '🟢 Activado y Protegido';
        btnSetup2FA.classList.add('hidden');
        btnDisable2FA.classList.remove('hidden');
      } else {
        badge.className = 'badge badge-red';
        badge.textContent = '⚪ Desactivado';
        btnSetup2FA.classList.remove('hidden');
        btnDisable2FA.classList.add('hidden');
      }

      loadPasskeysList();

    } catch (err) {
      showToast('Error cargando configuración de seguridad', 'error');
    }
  }

  // 1. Cambiar Frase Secreta del Vault
  document.getElementById('change-vault-phrase-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const adminPassword = document.getElementById('vault-admin-pass').value;
    const currentPhrase = document.getElementById('vault-current-phrase').value;
    const newPhrase = document.getElementById('vault-new-phrase').value;
    const confirmPhrase = document.getElementById('vault-confirm-phrase').value;

    if (newPhrase !== confirmPhrase) {
      return showToast('La nueva Frase Secreta y su confirmación no coinciden', 'error');
    }

    if (newPhrase.length < 8) {
      return showToast('La nueva Frase Secreta debe tener al menos 8 caracteres', 'error');
    }

    const btn = document.getElementById('btn-submit-change-vault');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Re-cifrando credenciales de clientes...</span>';

    try {
      const res = await API.post('/auth/change-vault-phrase', {
        adminPassword,
        currentPhrase,
        newPhrase
      });

      showToast(res.message, 'success');
      document.getElementById('change-vault-phrase-form').reset();
      updateVaultStatus(true);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  });

  // 2. Cambiar Contraseña de Administrador
  document.getElementById('change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const currentPassword = document.getElementById('pwd-current').value;
    const newPassword = document.getElementById('pwd-new').value;
    const confirmPassword = document.getElementById('pwd-confirm').value;

    if (newPassword !== confirmPassword) {
      return showToast('La nueva contraseña y su confirmación no coinciden', 'error');
    }

    if (newPassword.length < 8) {
      return showToast('La nueva contraseña debe tener al menos 8 caracteres', 'error');
    }

    try {
      const res = await API.post('/auth/change-password', {
        currentPassword,
        newPassword
      });

      showToast(res.message, 'success');
      document.getElementById('change-password-form').reset();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // 3. Passkeys List
  async function loadPasskeysList() {
    const container = document.getElementById('passkey-list-container');
    container.innerHTML = '<div class="text-muted">Cargando dispositivos...</div>';

    try {
      const list = await API.get('/auth/passkey/list');
      if (list.length === 0) {
        container.innerHTML = `
          <div class="text-muted py-3" style="font-size: 0.85rem;">
            No tienes Passkeys registradas en este momento. Haz clic en "➕ Registrar este Dispositivo" para habilitar Touch ID o Face ID.
          </div>
        `;
        return;
      }

      container.innerHTML = list.map(p => {
        const createdDate = new Date(p.created_at).toLocaleDateString();
        const lastUsed = p.last_used_at ? new Date(p.last_used_at).toLocaleDateString() : 'Nunca';

        return `
          <div class="passkey-item">
            <div class="passkey-info">
              <span class="passkey-icon">🔑</span>
              <div class="passkey-meta">
                <strong>${p.name}</strong>
                <small>Registrado el ${createdDate} • Último uso: ${lastUsed}</small>
              </div>
            </div>
            <button class="btn btn-sm btn-ghost text-red btn-delete-passkey" data-id="${p.id}" title="Eliminar Passkey">
              🗑️
            </button>
          </div>
        `;
      }).join('');

      container.querySelectorAll('.btn-delete-passkey').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (confirm('¿Eliminar esta Passkey biométrica de tu cuenta?')) {
            try {
              await API.delete(`/auth/passkey/${btn.dataset.id}`);
              showToast('Passkey eliminada', 'success');
              loadPasskeysList();
            } catch (err) {
              showToast(err.message, 'error');
            }
          }
        });
      });

    } catch (err) {
      container.innerHTML = '<div class="text-red">Error cargando Passkeys</div>';
    }
  }

  document.getElementById('btn-register-passkey').addEventListener('click', () => {
    document.getElementById('passkey-device-name').value = '';
    modalRegisterPasskey.classList.remove('hidden');
  });

  document.getElementById('modal-passkey-close').addEventListener('click', () => {
    modalRegisterPasskey.classList.add('hidden');
  });

  document.getElementById('btn-start-passkey-registration').addEventListener('click', async () => {
    const btn = document.getElementById('btn-start-passkey-registration');
    const deviceName = document.getElementById('passkey-device-name').value.trim() || 'Biometría (Touch ID / Face ID)';
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>👆 Toca tu sensor biométrico...</span>';

    try {
      const options = await API.post('/auth/passkey/register-options', {});

      let regResponse;
      if (startRegistration) {
        regResponse = await startRegistration(options);
      } else {
        throw new Error('WebAuthn no está soportado en este navegador');
      }

      const res = await API.post('/auth/passkey/register-verify', {
        response: regResponse,
        deviceName
      });

      if (res.success) {
        showToast('¡Passkey registrada exitosamente!', 'success');
        modalRegisterPasskey.classList.add('hidden');
        loadPasskeysList();
      }
    } catch (err) {
      showToast(`Error al registrar Passkey: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  });

  // 4. 2FA Setup
  document.getElementById('btn-setup-2fa').addEventListener('click', async () => {
    try {
      showToast('Generando código QR seguro...', 'info');
      const data = await API.post('/auth/2fa/setup', {});
      current2FASetupSecret = data.secret;

      document.getElementById('2fa-qr-image').src = data.qrCodeDataUrl;
      document.getElementById('2fa-secret-text').textContent = data.secret;
      document.getElementById('2fa-verify-code').value = '';

      modal2FA.classList.remove('hidden');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('modal-2fa-close').addEventListener('click', () => {
    modal2FA.classList.add('hidden');
  });

  document.getElementById('btn-confirm-enable-2fa').addEventListener('click', async () => {
    const code = document.getElementById('2fa-verify-code').value.trim();
    if (!code || code.length !== 6) {
      return showToast('Ingresa el código de 6 dígitos de tu app autenticadora', 'error');
    }

    try {
      const res = await API.post('/auth/2fa/enable', {
        secret: current2FASetupSecret,
        code
      });

      showToast(res.message, 'success');
      modal2FA.classList.add('hidden');
      loadSecurityView();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-disable-2fa').addEventListener('click', async () => {
    const password = prompt('Para desactivar 2FA, por favor ingresa tu contraseña de administrador:');
    if (!password) return;

    try {
      const res = await API.post('/auth/2fa/disable', { password });
      showToast(res.message, 'success');
      loadSecurityView();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // =========================================================================
  // 6. VISTA: CLIENTES
  // =========================================================================
  async function loadClients() {
    const container = document.getElementById('clients-list-container');
    container.innerHTML = '<div class="text-muted">Cargando servidores clientes...</div>';

    try {
      currentClients = await API.get('/clients');

      const clientSelect = document.getElementById('filter-backup-client');
      clientSelect.innerHTML = '<option value="">Todos los clientes</option>' + 
        currentClients.map(c => `<option value="${c.id}">${c.name}</option>`).join('');

      renderClientsGrid(currentClients);
    } catch (err) {
      showToast('Error cargando clientes', 'error');
    }
  }

  function renderClientsGrid(clients) {
    const container = document.getElementById('clients-list-container');
    if (clients.length === 0) {
      container.innerHTML = `
        <div class="glass-card text-center py-6" style="grid-column: 1 / -1;">
          <h3>No hay clientes configurados</h3>
          <p class="text-muted mt-4">Agrega tu primer servidor remoto para comenzar a respaldar bases de datos y DTEs.</p>
          <button class="btn btn-primary mt-4" id="btn-empty-new-client">➕ Crear Primer Cliente</button>
        </div>
      `;
      const btn = document.getElementById('btn-empty-new-client');
      if (btn) btn.addEventListener('click', openNewClientModal);
      return;
    }

    container.innerHTML = clients.map(c => {
      const lastStatus = c.last_backup_status;
      const statusClass = lastStatus === 'success' ? 'success' : lastStatus === 'failed' ? 'failed' : lastStatus === 'running' ? 'running' : 'text-muted';
      const statusText = lastStatus === 'success' ? 'Último Respaldo OK' : lastStatus === 'failed' ? 'Último Fallido' : lastStatus === 'running' ? 'En Ejecución' : 'Sin respaldos';
      const lastDate = c.last_backup_date ? new Date(c.last_backup_date).toLocaleString() : 'Nunca';

      return `
        <div class="client-card">
          <div class="client-card-header">
            <div class="client-card-title">
              <h3>${c.name}</h3>
              <span class="client-host-badge">${c.ssh_user}@${c.ssh_host}:${c.ssh_port}</span>
            </div>
            <span class="status-pill ${statusClass}">${statusText}</span>
          </div>

          <div class="client-card-meta">
            <div class="meta-item">
              <span class="meta-label">Motor de BD</span>
              <span class="meta-val">${c.db_type === 'none' ? 'Sin BD' : `${c.db_type.toUpperCase()} (${c.db_name || '-'})`}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">DTEs / Facturación</span>
              <span class="meta-val">${c.dtes_path ? '📁 Configurado' : '❌ No'}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">Programación Cron</span>
              <span class="meta-val font-mono">${c.cron_schedule || 'Manual'}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">Última ejecución</span>
              <span class="meta-val">${lastDate}</span>
            </div>
          </div>

          <div class="client-card-actions">
            <button class="btn btn-sm btn-primary btn-run-backup" data-client-id="${c.id}" data-client-name="${c.name}">
              ⚡ Respaldar Ahora
            </button>
            <button class="btn btn-sm btn-outline btn-edit-client" data-client-id="${c.id}">
              ✏️ Editar
            </button>
            <button class="btn btn-sm btn-ghost text-red btn-delete-client" data-client-id="${c.id}" data-client-name="${c.name}">
              🗑️
            </button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-run-backup').forEach(btn => {
      btn.addEventListener('click', () => triggerBackup(btn.dataset.clientId, btn.dataset.clientName));
    });

    container.querySelectorAll('.btn-edit-client').forEach(btn => {
      btn.addEventListener('click', () => openEditClientModal(btn.dataset.clientId));
    });

    container.querySelectorAll('.btn-delete-client').forEach(btn => {
      btn.addEventListener('click', () => deleteClient(btn.dataset.clientId, btn.dataset.clientName));
    });
  }

  document.getElementById('clients-search-input').addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    const filtered = currentClients.filter(c => 
      c.name.toLowerCase().includes(term) || 
      c.ssh_host.toLowerCase().includes(term) ||
      (c.tags && c.tags.toLowerCase().includes(term))
    );
    renderClientsGrid(filtered);
  });

  // =========================================================================
  // 7. MODAL DE CLIENTES
  // =========================================================================
  const clientForm = document.getElementById('client-form');
  const clientModalTitle = document.getElementById('client-modal-title');
  const tabBtns = clientModal.querySelectorAll('.tab-btn');
  const tabContents = clientModal.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  function openNewClientModal() {
    clientForm.reset();
    document.getElementById('client-form-id').value = '';
    clientModalTitle.textContent = '➕ Configurar Nuevo Cliente / Servidor';
    tabBtns[0].click();
    toggleAuthFields();
    toggleDbFields();
    clientModal.classList.remove('hidden');
  }

  document.getElementById('btn-new-client').addEventListener('click', openNewClientModal);
  document.getElementById('client-modal-close').addEventListener('click', () => clientModal.classList.add('hidden'));
  document.getElementById('client-modal-cancel').addEventListener('click', () => clientModal.classList.add('hidden'));

  function toggleAuthFields() {
    const checkedRadio = document.querySelector('input[name="client-ssh-auth-type"]:checked');
    const authType = checkedRadio ? checkedRadio.value : 'key';
    const passContainer = document.getElementById('ssh-pass-container');
    const customKeyContainer = document.getElementById('ssh-custom-key-container');

    if (authType === 'password') {
      passContainer.classList.remove('hidden');
      if (customKeyContainer) customKeyContainer.classList.add('hidden');
    } else if (authType === 'custom_key') {
      passContainer.classList.add('hidden');
      if (customKeyContainer) customKeyContainer.classList.remove('hidden');
    } else {
      // Llave SSH del Sistema
      passContainer.classList.add('hidden');
      if (customKeyContainer) customKeyContainer.classList.add('hidden');
    }
  }

  document.querySelectorAll('input[name="client-ssh-auth-type"]').forEach(r => {
    r.addEventListener('change', toggleAuthFields);
  });

  function toggleDbFields() {
    const dbType = document.getElementById('client-db-type').value;
    const dbContainer = document.getElementById('db-fields-container');
    const connMode = document.getElementById('client-db-connection-mode').value;
    const dockerGroup = document.getElementById('db-docker-container-group');
    const lblHost = document.getElementById('lbl-db-host');

    if (dbType === 'none') {
      dbContainer.classList.add('hidden');
    } else {
      dbContainer.classList.remove('hidden');
      document.getElementById('client-db-port').value = dbType === 'mysql' ? '3306' : '5432';

      if (connMode === 'docker_container') {
        dockerGroup.classList.remove('hidden');
        if (lblHost) lblHost.textContent = 'Host interno del Contenedor (127.0.0.1)';
      } else if (connMode === 'direct_tcp') {
        dockerGroup.classList.add('hidden');
        if (lblHost) lblHost.textContent = 'Host / IP Pública de la Base de Datos *';
      } else {
        dockerGroup.classList.add('hidden');
        if (lblHost) lblHost.textContent = 'Host de BD (Interno en el servidor - 127.0.0.1)';
      }
    }
  }

  document.getElementById('client-db-type').addEventListener('change', toggleDbFields);
  document.getElementById('client-db-connection-mode').addEventListener('change', toggleDbFields);

  async function openEditClientModal(clientId) {
    try {
      const c = await API.get(`/clients/${clientId}`);
      document.getElementById('client-form-id').value = c.id;
      clientModalTitle.textContent = `✏️ Editar Cliente: ${c.name}`;

      document.getElementById('client-name').value = c.name;
      document.getElementById('client-tags').value = c.tags || '';
      document.getElementById('client-ssh-host').value = c.ssh_host || '';
      document.getElementById('client-ssh-port').value = c.ssh_port || 22;
      document.getElementById('client-ssh-user').value = c.ssh_user || 'root';
      
      const authRadio = document.querySelector(`input[name="client-ssh-auth-type"][value="${c.ssh_auth_type}"]`);
      if (authRadio) authRadio.checked = true;
      document.getElementById('client-ssh-password').value = c.ssh_password || '';
      document.getElementById('client-ssh-private-key').value = c.has_ssh_private_key ? '********' : '';
      document.getElementById('client-ssh-passphrase').value = c.ssh_passphrase || '';

      document.getElementById('client-db-type').value = c.db_type || 'mysql';
      document.getElementById('client-db-connection-mode').value = c.db_connection_mode || 'ssh_tunnel';
      document.getElementById('client-db-docker-container').value = c.db_docker_container || '';
      document.getElementById('client-db-host').value = c.db_host || '127.0.0.1';
      document.getElementById('client-db-port').value = c.db_port || 3306;
      document.getElementById('client-db-name').value = c.db_name || '';
      document.getElementById('client-db-user').value = c.db_user || '';
      document.getElementById('client-db-pass').value = c.db_pass || '';

      document.getElementById('client-dtes-path').value = c.dtes_path || '';
      document.getElementById('client-cron-schedule').value = c.cron_schedule || '0 2 * * *';
      document.getElementById('client-is-active').value = c.is_active ? '1' : '0';
      document.getElementById('client-retention-days').value = c.retention_days || 30;
      document.getElementById('client-retention-count').value = c.retention_count || 14;
      document.getElementById('client-notify-email').value = c.notify_email || '';
      document.getElementById('client-notify-telegram').checked = !!c.notify_telegram;

      toggleAuthFields();
      toggleDbFields();
      tabBtns[0].click();

      clientModal.classList.remove('hidden');
    } catch (err) {
      showToast('Error al obtener datos del cliente', 'error');
    }
  }

  // Prueba de Conexión en 1 Clic con Diagnóstico Extendido
  document.getElementById('btn-test-client-connection').addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-client-connection');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Diagnosticando conexión SSH & BD...</span>';

    try {
      const payload = {
        client_id: document.getElementById('client-form-id').value,
        ssh_host: document.getElementById('client-ssh-host').value.trim(),
        ssh_port: document.getElementById('client-ssh-port').value,
        ssh_user: document.getElementById('client-ssh-user').value.trim(),
        ssh_auth_type: document.querySelector('input[name="client-ssh-auth-type"]:checked').value,
        ssh_password: document.getElementById('client-ssh-password').value,
        ssh_private_key: document.getElementById('client-ssh-private-key').value,
        ssh_passphrase: document.getElementById('client-ssh-passphrase').value,
        db_type: document.getElementById('client-db-type').value,
        db_connection_mode: document.getElementById('client-db-connection-mode').value,
        db_docker_container: document.getElementById('client-db-docker-container').value.trim(),
        db_host: document.getElementById('client-db-host').value.trim(),
        db_port: document.getElementById('client-db-port').value,
        db_name: document.getElementById('client-db-name').value.trim(),
        db_user: document.getElementById('client-db-user').value.trim(),
        db_pass: document.getElementById('client-db-pass').value
      };

      const result = await API.post('/clients/test-connection', payload);

      if (result.sshSuccess && result.dbSuccess) {
        alert(`✅ ¡CONEXIÓN PERFECTA!\n\n• Diagnóstico SSH: ${result.sshMessage || 'OK'}\n• Información del Sistema: ${result.osInfo || '-'}\n• Base de Datos: ${result.dbMessage}`);
        showToast(`✅ Conexión Perfecta: SSH OK y Base de Datos OK`, 'success');
      } else if (!result.sshSuccess) {
        alert(`❌ FALLO DE CONEXIÓN SSH:\n\n${result.sshMessage || result.message}`);
        showToast(`❌ Fallo SSH: ${result.sshMessage || result.message}`, 'error');
      } else {
        alert(`⚠️ SSH OK pero falló la Base de Datos:\n\n${result.dbMessage}`);
        showToast(`⚠️ SSH OK pero falló la Base de Datos`, 'error');
      }
    } catch (err) {
      alert(`❌ ERROR DE DIAGNÓSTICO:\n\n${err.message}`);
      showToast(`Error al probar conexión: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  });

  clientForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('client-form-submit');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>⏳ Guardando...</span>';

    const clientId = document.getElementById('client-form-id').value;
    const payload = {
      name: document.getElementById('client-name').value.trim(),
      tags: document.getElementById('client-tags').value.trim(),
      ssh_host: document.getElementById('client-ssh-host').value.trim(),
      ssh_port: document.getElementById('client-ssh-port').value,
      ssh_user: document.getElementById('client-ssh-user').value.trim(),
      ssh_auth_type: document.querySelector('input[name="client-ssh-auth-type"]:checked').value,
      ssh_password: document.getElementById('client-ssh-password').value,
      ssh_private_key: document.getElementById('client-ssh-private-key').value,
      ssh_passphrase: document.getElementById('client-ssh-passphrase').value,
      db_type: document.getElementById('client-db-type').value,
      db_connection_mode: document.getElementById('client-db-connection-mode').value,
      db_docker_container: document.getElementById('client-db-docker-container').value.trim(),
      db_host: document.getElementById('client-db-host').value.trim(),
      db_port: document.getElementById('client-db-port').value,
      db_name: document.getElementById('client-db-name').value.trim(),
      db_user: document.getElementById('client-db-user').value.trim(),
      db_pass: document.getElementById('client-db-pass').value,
      dtes_path: document.getElementById('client-dtes-path').value.trim(),
      cron_schedule: document.getElementById('client-cron-schedule').value.trim(),
      is_active: document.getElementById('client-is-active').value === '1',
      retention_days: document.getElementById('client-retention-days').value,
      retention_count: document.getElementById('client-retention-count').value,
      notify_email: document.getElementById('client-notify-email').value.trim(),
      notify_telegram: document.getElementById('client-notify-telegram').checked
    };

    try {
      if (clientId) {
        await API.put(`/clients/${clientId}`, payload);
        showToast('Cliente actualizado correctamente', 'success');
      } else {
        await API.post('/clients', payload);
        showToast('Cliente creado exitosamente', 'success');
      }

      clientModal.classList.add('hidden');
      loadClients();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>💾 Guardar Cliente</span>';
    }
  });

  async function deleteClient(clientId, clientName) {
    if (confirm(`¿Estás seguro de eliminar el cliente "${clientName}" y todo su historial de respaldos?`)) {
      try {
        await API.delete(`/clients/${clientId}`);
        showToast('Cliente eliminado correctamente', 'success');
        loadClients();
      } catch (err) {
        showToast('Error al eliminar cliente', 'error');
      }
    }
  }

  // =========================================================================
  // 8. EJECUCIÓN DE RESPALDOS & TERMINAL LIVE STREAMING
  // =========================================================================
  const terminalOutput = document.getElementById('terminal-output');
  const terminalStatus = document.getElementById('terminal-live-status');
  let activeStreamSource = null;
  let activeLogPolling = null;

  async function triggerBackup(clientId, clientName) {
    if (activeStreamSource) {
      activeStreamSource.close();
      activeStreamSource = null;
    }
    if (activeLogPolling) {
      clearInterval(activeLogPolling);
      activeLogPolling = null;
    }

    terminalOutput.innerHTML = '';
    document.getElementById('terminal-client-title').textContent = `Consola en Vivo: ${clientName}`;
    terminalStatus.textContent = 'Iniciando conexión SSH y pipeline de respaldo...';
    terminalModal.classList.remove('hidden');

    try {
      const res = await API.post(`/backups/run/${clientId}`, {});
      showToast(res.message, 'info');

      const backupId = res.backupId;
      if (backupId) {
        // 1. Suscripción por WebSocket
        API.subscribeLogs(backupId, (logLine) => {
          appendTerminalLog(logLine);
        });

        // 2. Suscripción por Server-Sent Events (SSE) de respaldo
        try {
          const token = API.getToken();
          activeStreamSource = new EventSource(`/api/backups/logs/${backupId}/stream?token=${token}`);
          activeStreamSource.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);
              if (data.log) appendTerminalLog(data.log);
            } catch (err) {}
          };
        } catch (e) {}

        // 3. Polling de respaldo para actualizar estado final y dashboard
        activeLogPolling = setInterval(async () => {
          try {
            const log = await API.get(`/backups/logs/${backupId}`);
            if (log) {
              terminalStatus.textContent = `Estado: ${log.status.toUpperCase()} | Duración: ${log.duration_seconds}s`;
              if (log.status === 'success' || log.status === 'failed') {
                clearInterval(activeLogPolling);
                activeLogPolling = null;
                if (activeStreamSource) {
                  activeStreamSource.close();
                  activeStreamSource = null;
                }
                loadDashboard();
                loadClients();
              }
            }
          } catch (e) {}
        }, 1500);
      }

    } catch (err) {
      showToast(err.message, 'error');
      terminalStatus.textContent = `Error: ${err.message}`;
    }
  }

  function appendTerminalLog(line) {
    const div = document.createElement('div');
    div.textContent = line;
    
    if (line.includes('ERROR') || line.includes('❌')) {
      div.style.color = 'var(--accent-red)';
    } else if (line.includes('✅') || line.includes('🎉')) {
      div.style.color = 'var(--accent-green)';
    } else if (line.includes('⚠️')) {
      div.style.color = 'var(--accent-amber)';
    }

    terminalOutput.appendChild(div);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  document.getElementById('terminal-modal-close').addEventListener('click', () => {
    terminalModal.classList.add('hidden');
    loadDashboard();
  });

  document.getElementById('btn-clear-terminal').addEventListener('click', () => {
    terminalOutput.innerHTML = '';
  });

  document.getElementById('btn-copy-terminal').addEventListener('click', () => {
    navigator.clipboard.writeText(terminalOutput.innerText);
    showToast('Logs copiados al portapapeles', 'success');
  });

  document.getElementById('btn-run-all-backups').addEventListener('click', async () => {
    if (confirm('¿Deseas iniciar el respaldo secuencial de todos los clientes activos ahora mismo?')) {
      terminalOutput.innerHTML = '';
      document.getElementById('terminal-client-title').textContent = '🚀 Ejecución en Lote de Respaldos (Batch)';
      terminalStatus.textContent = 'Iniciando pipeline de respaldo en lote...';
      terminalModal.classList.remove('hidden');
      appendTerminalLog('[INFO] Iniciando respaldo secuencial de clientes activos...');

      try {
        const res = await API.post('/backups/run-all', {});
        showToast(res.message, 'success');

        // Polling en vivo para mostrar el progreso de todos los clientes del lote
        let batchPolling = setInterval(async () => {
          try {
            const stats = await API.get('/stats/dashboard');
            if (stats && stats.backups) {
              terminalStatus.textContent = `En Proceso: ${stats.backups.running} | Éxitos: ${stats.backups.success} | Fallidos: ${stats.backups.failed}`;
              
              if (stats.recentLogs && stats.recentLogs.length > 0) {
                const runningLog = stats.recentLogs.find(l => l.status === 'running');
                if (runningLog) {
                  const fullLog = await API.get(`/backups/logs/${runningLog.id}`);
                  if (fullLog && fullLog.log_output) {
                    terminalOutput.innerHTML = '';
                    fullLog.log_output.split('\n').forEach(line => {
                      if (line) appendTerminalLog(line);
                    });
                  }
                }
              }

              if (stats.backups.running === 0) {
                clearInterval(batchPolling);
                appendTerminalLog('\n🎉 ¡TODOS LOS CLIENTES DEL LOTE HAN SIDO PROCESADOS EXITOSAMENTE!');
                terminalStatus.textContent = 'Lote finalizado';
                loadDashboard();
                loadClients();
                loadBackupsHistory();
              }
            }
          } catch (e) {}
        }, 2000);

      } catch (err) {
        showToast(err.message, 'error');
        terminalStatus.textContent = `Error: ${err.message}`;
      }
    }
  });

  // =========================================================================
  // 9. VISTA: RESPALDOS & HISTORIAL
  // =========================================================================
  async function loadBackupsHistory() {
    const clientId = document.getElementById('filter-backup-client').value;
    const status = document.getElementById('filter-backup-status').value;
    const tbody = document.getElementById('backups-tbody');

    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-6 text-muted">Cargando registros de respaldos...</td></tr>';

    try {
      const url = `/backups/logs?${clientId ? `clientId=${clientId}&` : ''}${status ? `status=${status}&` : ''}limit=100`;
      const logs = await API.get(url);

      if (!Array.isArray(logs) || logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center py-6 text-muted">No se encontraron registros de respaldo.</td></tr>';
        return;
      }

      tbody.innerHTML = logs.map(log => {
        const statusClass = log.status === 'success' ? 'success' : log.status === 'failed' ? 'failed' : 'running';
        const statusText = log.status === 'success' ? 'Exitoso' : log.status === 'failed' ? 'Fallido' : 'En proceso';
        let dateFormatted = '—';
        if (log.start_time) {
          try {
            dateFormatted = new Date(log.start_time).toLocaleString();
          } catch (_) {
            dateFormatted = String(log.start_time);
          }
        }
        const sizeMB = log.file_size_bytes ? (Number(log.file_size_bytes) / (1024 * 1024)).toFixed(2) : '0.00';
        const checksumShort = log.checksum_sha256 ? `${log.checksum_sha256.substring(0, 10)}...` : '-';
        const clientName = log.client_name || 'Cliente';
        const duration = log.duration_seconds !== undefined ? log.duration_seconds : 0;

        return `
          <tr>
            <td><span class="status-pill ${statusClass}">${statusText}</span></td>
            <td><strong>${clientName}</strong></td>
            <td>${dateFormatted}</td>
            <td>${duration}s</td>
            <td>${log.status === 'success' ? `${sizeMB} MB` : '-'}</td>
            <td><code title="${log.checksum_sha256 || ''}">${checksumShort}</code></td>
            <td>${log.is_replicated_cloud ? '☁️ S3' : '—'}</td>
            <td>
              <div style="display: flex; gap: 4px;">
                <button class="btn btn-sm btn-ghost btn-view-log-detail" data-log-id="${log.id}" title="Ver Consola">📜 Logs</button>
                ${log.status === 'success' ? `
                  <button class="btn btn-sm btn-primary btn-inspect-backup" data-log-id="${log.id}" title="Ver contenido interno del respaldo">🔍 Ver Archivos</button>
                  <button class="btn btn-sm btn-outline btn-download-dec" data-log-id="${log.id}" title="Descargar Descifrado (.tar.gz)">🔓 Bajar</button>
                  <button class="btn btn-sm btn-ghost btn-download-enc" data-log-id="${log.id}" title="Descargar Cifrado AES-256">🔒 .enc</button>
                  <button class="btn btn-sm btn-ghost btn-share-link" data-log-id="${log.id}" title="Generar Enlace Seguro">🔗</button>
                ` : ''}
                <button class="btn btn-sm btn-ghost text-red btn-delete-log" data-log-id="${log.id}" title="Eliminar Registro">🗑️</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');

      tbody.querySelectorAll('.btn-view-log-detail').forEach(btn => {
        btn.addEventListener('click', () => viewLogDetails(btn.dataset.logId));
      });

      tbody.querySelectorAll('.btn-inspect-backup').forEach(btn => {
        btn.addEventListener('click', () => inspectBackup(btn.dataset.logId));
      });

      tbody.querySelectorAll('.btn-download-enc').forEach(btn => {
        btn.addEventListener('click', () => downloadBackup(btn.dataset.logId, false));
      });

      tbody.querySelectorAll('.btn-download-dec').forEach(btn => {
        btn.addEventListener('click', () => downloadBackup(btn.dataset.logId, true));
      });

      tbody.querySelectorAll('.btn-share-link').forEach(btn => {
        btn.addEventListener('click', () => openShareLinkModal(btn.dataset.logId));
      });

      tbody.querySelectorAll('.btn-delete-log').forEach(btn => {
        btn.addEventListener('click', () => deleteBackupLog(btn.dataset.logId));
      });

    } catch (err) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="text-center py-6 text-red">
            <p>Error cargando historial de respaldos (${err.message || 'error de conexión'}).</p>
            <button class="btn btn-sm btn-outline mt-2" id="btn-retry-history">🔄 Reintentar</button>
          </td>
        </tr>
      `;
      document.getElementById('btn-retry-history')?.addEventListener('click', loadBackupsHistory);
      showToast('Error cargando historial de respaldos: ' + (err.message || ''), 'error');
    }
  }

  window.__dearbackup_loadHistory = loadBackupsHistory;

  document.getElementById('filter-backup-client').addEventListener('change', loadBackupsHistory);
  document.getElementById('filter-backup-status').addEventListener('change', loadBackupsHistory);
  document.getElementById('refresh-backups-btn').addEventListener('click', loadBackupsHistory);

  // Vaciar todo el historial de respaldos y logs
  const btnClearHistory = document.getElementById('btn-clear-backups-history');
  if (btnClearHistory) {
    btnClearHistory.addEventListener('click', async () => {
      const confirmed = confirm('⚠️ ¿Estás seguro de que deseas vaciar todo el historial de respaldos y registros?\n\nEsta acción borrará los registros de logs antiguos para que puedas visualizar las nuevas ejecuciones limpiamente. Tus clientes, llaves y configuraciones NO se verán afectados.');
      if (!confirmed) return;

      const originalText = btnClearHistory.innerHTML;
      btnClearHistory.disabled = true;
      btnClearHistory.innerHTML = '<span>⏳ Vaciando historial...</span>';

      try {
        const res = await API.post('/backups/clear-logs', {});
        showToast(res.message || 'Historial vaciado correctamente', 'success');
        loadBackupsHistory();
        loadDashboard();
      } catch (err) {
        showToast(`Error al vaciar historial: ${err.message}`, 'error');
      } finally {
        btnClearHistory.disabled = false;
        btnClearHistory.innerHTML = originalText;
      }
    });
  }

  async function viewLogDetails(logId) {
    try {
      const log = await API.get(`/backups/logs/${logId}`);
      terminalOutput.innerHTML = '';
      document.getElementById('terminal-client-title').textContent = `Logs de Respaldo: ${log.client_name}`;
      terminalStatus.textContent = `Estado: ${log.status.toUpperCase()} | Duración: ${log.duration_seconds || 0}s`;

      if (log.log_output && log.log_output.trim().length > 0) {
        log.log_output.split('\n').forEach(line => {
          if (line) appendTerminalLog(line);
        });
      } else {
        appendTerminalLog(`[${log.status.toUpperCase()}] No hay registros adicionales generados.`);
      }

      terminalModal.classList.remove('hidden');

      // Si aún está en ejecución, suscribir por Server-Sent Events en tiempo real
      if (log.status === 'running') {
        const sseUrl = `/api/backups/logs/${logId}/stream?token=${encodeURIComponent(API.token || '')}`;
        const eventSource = new EventSource(sseUrl);

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.log) appendTerminalLog(data.log);
          } catch (e) {}
        };

        const closeBtn = document.getElementById('terminal-modal-close');
        const handleClose = () => {
          eventSource.close();
          closeBtn.removeEventListener('click', handleClose);
        };
        closeBtn.addEventListener('click', handleClose);
      }

    } catch (err) {
      showToast('Error al obtener detalle del log: ' + err.message, 'error');
    }
  }

  const inspectModal = document.getElementById('inspect-backup-modal');
  let currentInspectLogId = null;

  async function inspectBackup(logId) {
    currentInspectLogId = logId;
    const tbody = document.getElementById('inspect-tbody');
    tbody.innerHTML = '<tr><td colspan="3" class="text-center py-6 text-muted">⏳ Descifrando temporalmente y leyendo estructura de archivos...</td></tr>';
    inspectModal.classList.remove('hidden');

    try {
      const data = await API.get(`/backups/inspect/${logId}`);
      document.getElementById('inspect-modal-title').textContent = `🔍 Archivos en: ${data.backupFileName}`;
      document.getElementById('inspect-total-size').textContent = `📦 Peso Total del Paquete: ${data.fileSizeFormatted}`;

      if (!data.files || data.files.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center py-4 text-muted">No se encontraron archivos en el paquete.</td></tr>';
        return;
      }

      tbody.innerHTML = data.files.map(file => {
        let icon = '📄';
        if (file.fileName.endsWith('.sql.gz') || file.fileName.endsWith('.sql')) {
          icon = '💾';
        } else if (file.fileName.endsWith('.tar.gz') || file.fileName.endsWith('.zip')) {
          icon = '📁';
        } else if (file.fileName.endsWith('.xml') || file.fileName.endsWith('.pdf')) {
          icon = '🧾';
        }

        return `
          <tr>
            <td><strong>${icon} ${file.fileName}</strong></td>
            <td><code>${file.sizeFormatted}</code></td>
            <td><small class="text-muted">${file.permissions || '-'}</small></td>
          </tr>
        `;
      }).join('');

    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="3" class="text-center py-4 text-red">❌ Error al inspeccionar: ${err.message}</td></tr>`;
    }
  }

  document.getElementById('inspect-modal-close').addEventListener('click', () => {
    inspectModal.classList.add('hidden');
  });
  document.getElementById('btn-inspect-close').addEventListener('click', () => {
    inspectModal.classList.add('hidden');
  });
  document.getElementById('btn-inspect-download-dec').addEventListener('click', () => {
    if (currentInspectLogId) {
      downloadBackup(currentInspectLogId, true);
    }
  });

  function downloadBackup(logId, decrypt = false) {
    const token = API.getToken();
    const url = `/api/backups/download/${logId}?decrypt=${decrypt}&token=${token}`;
    const a = document.createElement('a');
    a.href = url;
    a.setAttribute('download', '');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function deleteBackupLog(logId) {
    if (confirm('¿Deseas eliminar este registro de respaldo y su archivo físico?')) {
      try {
        await API.delete(`/backups/logs/${logId}`);
        showToast('Registro eliminado', 'success');
        loadBackupsHistory();
      } catch (err) {
        showToast('Error al eliminar registro', 'error');
      }
    }
  }

  // =========================================================================
  // 10. MODAL DE ENLACES SEGUROS TEMPORALES
  // =========================================================================
  function openShareLinkModal(backupLogId) {
    document.getElementById('share-backup-id').value = backupLogId;
    document.getElementById('share-result-container').classList.add('hidden');
    shareLinkModal.classList.remove('hidden');
  }

  document.getElementById('share-link-modal-close').addEventListener('click', () => {
    shareLinkModal.classList.add('hidden');
  });

  document.getElementById('btn-generate-share-link').addEventListener('click', async () => {
    const backupId = document.getElementById('share-backup-id').value;
    const hours = document.getElementById('share-hours').value;
    const maxDownloads = document.getElementById('share-max-downloads').value;

    try {
      const res = await API.post('/backups/create-share-link', {
        backup_log_id: backupId,
        hours,
        max_downloads: maxDownloads
      });

      document.getElementById('share-generated-url').value = res.downloadUrl;
      document.getElementById('share-result-container').classList.remove('hidden');
      showToast('¡Enlace seguro generado exitosamente!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-copy-generated-url').addEventListener('click', () => {
    const input = document.getElementById('share-generated-url');
    navigator.clipboard.writeText(input.value);
    showToast('Enlace copiado al portapapeles', 'success');
  });

  // =========================================================================
  // 11. MODAL DE LLAVE SSH PÚBLICA GLOBAL
  // =========================================================================
  document.getElementById('global-ssh-key-btn').addEventListener('click', async () => {
    try {
      const res = await API.get('/settings/ssh-key');
      document.getElementById('ssh-public-key-display').value = res.publicKey;
      
      const copyCmd = `echo "${res.publicKey.trim()}" >> ~/.ssh/authorized_keys`;
      document.getElementById('ssh-copy-command').textContent = copyCmd;

      sshKeyModal.classList.remove('hidden');
    } catch (err) {
      showToast('Error obteniendo llave SSH pública', 'error');
    }
  });

  document.getElementById('ssh-key-modal-close').addEventListener('click', () => {
    sshKeyModal.classList.add('hidden');
  });

  document.getElementById('btn-copy-ssh-key').addEventListener('click', () => {
    const key = document.getElementById('ssh-public-key-display').value;
    navigator.clipboard.writeText(key);
    showToast('Llave pública copiada al portapapeles', 'success');
  });

  // =========================================================================
  // 12. VISTA: CONFIGURACIÓN GLOBAL & PROBADOR DE CORREO SMTP CON SSL/TLS
  // =========================================================================
  const smtpEncSelect = document.getElementById('smtp-encryption-type');
  const smtpPortInput = document.getElementById('smtp-port');

  smtpEncSelect.addEventListener('change', () => {
    const enc = smtpEncSelect.value;
    if (enc === 'ssl' && (smtpPortInput.value === '587' || smtpPortInput.value === '25')) {
      smtpPortInput.value = '465';
    } else if (enc === 'tls' && (smtpPortInput.value === '465' || smtpPortInput.value === '25')) {
      smtpPortInput.value = '587';
    } else if (enc === 'none' && (smtpPortInput.value === '465' || smtpPortInput.value === '587')) {
      smtpPortInput.value = '25';
    }
  });

  async function loadSettings() {
    try {
      const smtp = await API.get('/settings/smtp');
      document.getElementById('smtp-enabled').checked = smtp.isEnabled;
      document.getElementById('smtp-host').value = smtp.host || '';
      document.getElementById('smtp-port').value = smtp.port || 587;
      document.getElementById('smtp-encryption-type').value = smtp.encryptionType || (Number(smtp.port) === 465 ? 'ssl' : 'tls');
      document.getElementById('smtp-user').value = smtp.user || '';
      document.getElementById('smtp-pass').value = smtp.pass || '';
      document.getElementById('smtp-from-name').value = smtp.fromName || '';
      document.getElementById('smtp-from-email').value = smtp.fromEmail || '';

      if (smtp.user && !document.getElementById('smtp-test-target-email').value) {
        document.getElementById('smtp-test-target-email').value = smtp.fromEmail || smtp.user;
      }

      const tel = await API.get('/settings/telegram');
      document.getElementById('telegram-enabled').checked = tel.isEnabled;
      document.getElementById('telegram-bot-token').value = tel.botToken || '';
      document.getElementById('telegram-chat-id').value = tel.chatId || '';

      const cloud = await API.get('/settings/cloud');
      document.getElementById('cloud-enabled').checked = cloud.isEnabled;
      document.getElementById('cloud-provider').value = cloud.provider || 'r2';
      document.getElementById('cloud-bucket').value = cloud.bucket || '';
      document.getElementById('cloud-endpoint').value = cloud.endpoint || '';
      document.getElementById('cloud-region').value = cloud.region || 'auto';
      document.getElementById('cloud-access-key').value = cloud.accessKeyId || '';
      document.getElementById('cloud-secret-key').value = cloud.secretAccessKey || '';
      if (document.getElementById('cloud-max-storage')) {
        document.getElementById('cloud-max-storage').value = cloud.maxStorageGB !== undefined ? cloud.maxStorageGB : 10;
      }

      updateSelfBackupStatus();
    } catch (err) {
      showToast('Error cargando configuración', 'error');
    }
  }

  document.getElementById('smtp-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await API.post('/settings/smtp', {
        isEnabled: document.getElementById('smtp-enabled').checked,
        host: document.getElementById('smtp-host').value,
        port: document.getElementById('smtp-port').value,
        encryptionType: document.getElementById('smtp-encryption-type').value,
        user: document.getElementById('smtp-user').value,
        pass: document.getElementById('smtp-pass').value,
        fromName: document.getElementById('smtp-from-name').value,
        fromEmail: document.getElementById('smtp-from-email').value
      });
      showToast('Configuración SMTP guardada correctamente', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Modal del Probador de Correo
  function openSMTPTesterModal() {
    const userEmail = document.getElementById('smtp-user').value.trim();
    const fromEmail = document.getElementById('smtp-from-email').value.trim();
    if (fromEmail) {
      document.getElementById('smtp-test-target-email').value = fromEmail;
    } else if (userEmail) {
      document.getElementById('smtp-test-target-email').value = userEmail;
    }
    document.getElementById('smtp-test-result-box').classList.add('hidden');
    modalSMTPTester.classList.remove('hidden');
  }

  document.getElementById('btn-open-smtp-tester').addEventListener('click', openSMTPTesterModal);
  document.getElementById('btn-test-smtp').addEventListener('click', openSMTPTesterModal);

  document.getElementById('modal-smtp-tester-close').addEventListener('click', () => {
    modalSMTPTester.classList.add('hidden');
  });

  document.getElementById('btn-execute-smtp-test').addEventListener('click', async () => {
    const testEmail = document.getElementById('smtp-test-target-email').value.trim();
    if (!testEmail) {
      return showToast('Ingresa un correo electrónico destinatario para la prueba', 'error');
    }

    const btn = document.getElementById('btn-execute-smtp-test');
    const resultBox = document.getElementById('smtp-test-result-box');
    const resultContent = document.getElementById('smtp-test-result-content');

    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Conectando y enviando correo de prueba...</span>';
    resultBox.classList.add('hidden');

    try {
      const res = await API.post('/settings/smtp/test', {
        host: document.getElementById('smtp-host').value,
        port: document.getElementById('smtp-port').value,
        encryptionType: document.getElementById('smtp-encryption-type').value,
        user: document.getElementById('smtp-user').value,
        pass: document.getElementById('smtp-pass').value,
        fromName: document.getElementById('smtp-from-name').value,
        fromEmail: document.getElementById('smtp-from-email').value,
        testEmail
      });

      resultBox.classList.remove('hidden');

      if (res.success) {
        resultContent.style.color = 'var(--accent-green)';
        resultContent.textContent = `✅ ÉXITO:\n${res.message}\n\nDetalles del Diagnóstico:\n${JSON.stringify(res.diagnostic, null, 2)}`;
        showToast('¡Correo de prueba enviado con éxito!', 'success');
      } else {
        resultContent.style.color = 'var(--accent-red)';
        resultContent.textContent = `❌ FALLO DE CONEXIÓN SMTP:\n${res.message}`;
        showToast('Error al enviar correo de prueba', 'error');
      }

    } catch (err) {
      resultBox.classList.remove('hidden');
      resultContent.style.color = 'var(--accent-red)';
      resultContent.textContent = `❌ ERROR:\n${err.message}`;
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  });

  // Telegram Auto-Detect Chat ID
  document.getElementById('btn-detect-telegram-chat').addEventListener('click', async () => {
    const botToken = document.getElementById('telegram-bot-token').value.trim();
    if (!botToken) {
      return showToast('Ingresa primero el Bot Token de tu bot en Telegram', 'error');
    }

    const btn = document.getElementById('btn-detect-telegram-chat');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Detectando...</span>';

    try {
      const res = await API.post('/settings/telegram/detect-chat-id', { botToken });
      document.getElementById('telegram-chat-id').value = res.chatId;
      showToast(`¡Chat ID detectado con éxito: ${res.chatId} (${res.chatTitle})!`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  });

  // Telegram Test
  document.getElementById('telegram-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await API.post('/settings/telegram', {
        isEnabled: document.getElementById('telegram-enabled').checked,
        botToken: document.getElementById('telegram-bot-token').value,
        chatId: document.getElementById('telegram-chat-id').value
      });
      showToast('Configuración de Telegram guardada', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-test-telegram').addEventListener('click', async () => {
    try {
      showToast('Enviando alerta de prueba a Telegram...', 'info');
      const res = await API.post('/settings/telegram/test', {
        botToken: document.getElementById('telegram-bot-token').value,
        chatId: document.getElementById('telegram-chat-id').value
      });

      if (res.success) {
        showToast(res.message, 'success');
      } else {
        showToast(res.message, 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Cloud S3 Test
  document.getElementById('cloud-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await API.post('/settings/cloud', {
        isEnabled: document.getElementById('cloud-enabled').checked,
        provider: document.getElementById('cloud-provider').value,
        bucket: document.getElementById('cloud-bucket').value,
        endpoint: document.getElementById('cloud-endpoint').value,
        region: document.getElementById('cloud-region').value,
        accessKeyId: document.getElementById('cloud-access-key').value,
        secretAccessKey: document.getElementById('cloud-secret-key').value,
        maxStorageGB: Number(document.getElementById('cloud-max-storage').value) || 10
      });
      showToast('Configuración Cloud S3 guardada con éxito', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-test-cloud').addEventListener('click', async () => {
    try {
      showToast('Probando conexión y permisos en el bucket...', 'info');
      const res = await API.post('/settings/cloud/test', {
        provider: document.getElementById('cloud-provider').value,
        bucket: document.getElementById('cloud-bucket').value,
        endpoint: document.getElementById('cloud-endpoint').value,
        region: document.getElementById('cloud-region').value,
        accessKeyId: document.getElementById('cloud-access-key').value,
        secretAccessKey: document.getElementById('cloud-secret-key').value
      });

      if (res.success) {
        showToast(res.message, 'success');
      } else {
        showToast(res.message, 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Botón de Purga Forzada de Copias Viejas en la Nube (R2 / S3)
  const btnPurgeCloud = document.getElementById('btn-purge-cloud-retention');
  if (btnPurgeCloud) {
    btnPurgeCloud.addEventListener('click', async () => {
      if (!confirm('¿Deseas purgar de tu almacenamiento en la nube todas las copias viejas que excedan el límite de retención de cada cliente?')) return;
      const originalText = btnPurgeCloud.innerHTML;
      btnPurgeCloud.disabled = true;
      btnPurgeCloud.innerHTML = '<span>⏳ Purgando Cloud...</span>';

      try {
        const res = await API.post('/backups/purge-cloud', {});
        showToast(res.message, 'success');
        loadBackupsHistory();
        loadDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btnPurgeCloud.disabled = false;
        btnPurgeCloud.innerHTML = originalText;
      }
    });
  }

  const btnDashPurgeCloud = document.getElementById('btn-dash-purge-cloud');
  if (btnDashPurgeCloud && btnPurgeCloud) {
    btnDashPurgeCloud.addEventListener('click', () => btnPurgeCloud.click());
  }

  // Botón de Liberación de Memoria RAM (Garbage Collection)
  const btnFreeRam = document.getElementById('btn-free-ram-gc');
  if (btnFreeRam) {
    btnFreeRam.addEventListener('click', async () => {
      const originalText = btnFreeRam.innerHTML;
      btnFreeRam.disabled = true;
      btnFreeRam.innerHTML = '<span>⏳...</span>';
      try {
        const res = await API.post('/stats/free-memory', {});
        showToast(res.message, 'success');
        loadDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btnFreeRam.disabled = false;
        btnFreeRam.innerHTML = originalText;
      }
    });
  }

  // =========================================================================
  // 12. LIBERACIÓN / PURGA DE ESPACIO LOCAL
  // =========================================================================
  const purgeModal = document.getElementById('purge-space-modal');
  const btnOpenPurgeModal = document.getElementById('btn-open-purge-modal');
  const btnClosePurgeModal = document.getElementById('purge-modal-close');
  const btnCancelPurgeModal = document.getElementById('purge-modal-cancel');
  const btnExecutePurge = document.getElementById('btn-execute-purge');
  const purgeStorageSummary = document.getElementById('purge-storage-summary');

  const btnDashPurgeLocal = document.getElementById('btn-dash-purge-local');
  if (btnDashPurgeLocal && btnOpenPurgeModal) {
    btnDashPurgeLocal.addEventListener('click', () => btnOpenPurgeModal.click());
  }

  if (btnOpenPurgeModal) {
    btnOpenPurgeModal.addEventListener('click', async () => {
      purgeModal.classList.remove('hidden');
      purgeStorageSummary.textContent = 'Calculando espacio ocupado...';

      try {
        const info = await API.get('/backups/storage-info');
        purgeStorageSummary.innerHTML = `
          <strong>Total en Disco Local:</strong> ${info.localMB} MB (${info.totalLocalFiles} archivos)<br>
          <span style="color: var(--accent-green);">☁️ Ya respaldados en Nube (Seguros para purgar):</span> ${info.cloudBackedMB} MB<br>
          <span class="text-muted">🧹 Archivos temporales:</span> ${info.tempMB} MB
        `;
      } catch (err) {
        purgeStorageSummary.textContent = 'Error obteniendo métricas de almacenamiento.';
      }
    });
  }

  const closePurge = () => purgeModal.classList.add('hidden');
  if (btnClosePurgeModal) btnClosePurgeModal.addEventListener('click', closePurge);
  if (btnCancelPurgeModal) btnCancelPurgeModal.addEventListener('click', closePurge);

  if (btnExecutePurge) {
    btnExecutePurge.addEventListener('click', async () => {
      const selectedMode = document.querySelector('input[name="purge-mode"]:checked')?.value || 'cloud_only';
      
      const originalText = btnExecutePurge.innerHTML;
      btnExecutePurge.disabled = true;
      btnExecutePurge.innerHTML = '<span>⏳ Purgando archivos...</span>';

      try {
        const res = await API.post('/backups/purge-local', { mode: selectedMode });
        showToast(res.message, 'success');
        closePurge();
        loadBackupsHistory();
        loadDashboard();
      } catch (err) {
        showToast(`Error al purgar espacio: ${err.message}`, 'error');
      } finally {
        btnExecutePurge.disabled = false;
        btnExecutePurge.innerHTML = originalText;
      }
    });
  }

  // =========================================================================
  // 13. PORTABILIDAD, EXPORTAR / IMPORTAR Y AUTO-RESPALDO (EN CONFIGURACIÓN)
  // =========================================================================
  function triggerDownloadRawDb() {
    const token = API.getToken();
    if (!token) return showToast('Sesión no válida o expirada', 'error');
    showToast('Generando copia consolidada de dearbackup.db...', 'info');
    window.location.href = `/api/settings/download-database?token=${encodeURIComponent(token)}`;
  }

  // Descarga directa de la base de datos SQLite
  const btnDownloadRawDb = document.getElementById('btn-download-raw-db');
  if (btnDownloadRawDb) {
    btnDownloadRawDb.addEventListener('click', (e) => {
      e.preventDefault();
      triggerDownloadRawDb();
    });
  }

  // Exportar configuración cifrada (.dearconfig)
  const exportConfigForm = document.getElementById('export-config-form');
  if (exportConfigForm) {
    exportConfigForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-export-config');
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span>⏳ Cifrando y empaquetando...</span>';

      try {
        const passphrase = document.getElementById('export-config-password').value;
        const res = await API.post('/settings/export-config', { passphrase });

        if (res.package) {
          const jsonBlob = new Blob([JSON.stringify(res.package, null, 2)], { type: 'application/json' });
          const downloadUrl = URL.createObjectURL(jsonBlob);
          const link = document.createElement('a');
          link.href = downloadUrl;
          link.download = res.filename || `dearbackup-config-${new Date().toISOString().slice(0, 10)}.dearconfig`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(downloadUrl);

          let msg = '¡Archivo .dearconfig exportado y descargado con éxito!';
          if (res.package && res.package.summary) {
            const s = res.package.summary;
            const parts = [];
            if (s.clientCount !== undefined) parts.push(`${s.clientCount} clientes`);
            if (s.hasSmtpConfig) parts.push('Correo SMTP');
            if (s.hasCloudConfig) parts.push('Cloud S3/R2');
            if (s.hasTelegramConfig) parts.push('Telegram');
            if (s.hasSystemSSHKey) parts.push('Llaves SSH');
            if (s.userCount) parts.push(`${s.userCount} usuarios`);
            if (parts.length > 0) {
              msg = `¡Exportación exitosa! Se empaquetó copia exacta: ${parts.join(', ')}.`;
            }
          }
          showToast(msg, 'success');
          document.getElementById('export-config-password').value = '';
        }
      } catch (err) {
        showToast(`Error al exportar configuración: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    });
  }

  // Importar configuración cifrada (.dearconfig)
  const importConfigForm = document.getElementById('import-config-form');
  if (importConfigForm) {
    importConfigForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('import-config-file');
      if (!fileInput.files || fileInput.files.length === 0) {
        return showToast('Por favor selecciona un archivo .dearconfig a restaurar', 'error');
      }

      const passphrase = document.getElementById('import-config-password').value;
      const btn = document.getElementById('btn-import-config');
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span>⏳ Descifrando y restaurando...</span>';

      const file = fileInput.files[0];
      const reader = new FileReader();

      reader.onload = async (event) => {
        try {
          const fileContent = event.target.result;
          const res = await API.post('/settings/import-config', {
            packageData: fileContent,
            passphrase
          });

          showToast(res.message, 'success');
          importConfigForm.reset();
          loadClients();
          loadSettings();
          loadDashboard();
        } catch (err) {
          showToast(`Fallo al importar: ${err.message}`, 'error');
        } finally {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      };

      reader.onerror = () => {
        btn.disabled = false;
        btn.innerHTML = originalText;
        showToast('Error al leer el archivo seleccionado', 'error');
      };

      reader.readAsText(file);
    });
  }

  // Subir y restaurar archivo físico dearbackup.db desde la web
  const restoreDbForm = document.getElementById('restore-db-form');
  if (restoreDbForm) {
    restoreDbForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('restore-db-file');
      if (!fileInput.files || fileInput.files.length === 0) {
        return showToast('Por favor selecciona un archivo .db válido', 'error');
      }

      const file = fileInput.files[0];
      const confirmed = confirm('⚠️ ATENCIÓN: Esta acción reemplazará la base de datos actual con la del archivo seleccionado.\n\nEl sistema creará una copia de respaldo automática antes de proceder y reiniciará la sesión.\n\n¿Deseas continuar con la restauración?');
      if (!confirmed) return;

      const btn = document.getElementById('btn-restore-db');
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span>⏳ Restaurando base de datos...</span>';

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const arrayBuffer = event.target.result;
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          const len = bytes.byteLength;
          for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);
          const payload = {
            dbBase64: base64,
            newAdminPassword: document.getElementById('restore-db-new-password')?.value || undefined,
            vaultPassphrase: document.getElementById('restore-db-vault-phrase')?.value || undefined
          };

          const res = await API.post('/settings/restore-database', payload);
          let extraMsg = '';
          if (res.targetUsername) {
            extraMsg = ` (Usuario admin: ${res.targetUsername})`;
          }
          showToast(`${res.message}${extraMsg}`, 'success');
          setTimeout(() => {
            window.location.reload();
          }, 2500);
        } catch (err) {
          showToast(`Error al restaurar: ${err.message}`, 'error');
        } finally {
          btn.disabled = false;
          btn.innerHTML = originalText;
        }
      };

      reader.onerror = () => {
        btn.disabled = false;
        btn.innerHTML = originalText;
        showToast('Error al leer el archivo de base de datos', 'error');
      };

      reader.readAsArrayBuffer(file);
    });
  }

  // Disparar auto-respaldo nocturno inmediatamente
  const btnTriggerSelfBackup = document.getElementById('btn-trigger-self-backup');
  if (btnTriggerSelfBackup) {
    btnTriggerSelfBackup.addEventListener('click', async () => {
      const originalText = btnTriggerSelfBackup.innerHTML;
      btnTriggerSelfBackup.disabled = true;
      btnTriggerSelfBackup.innerHTML = '<span>⏳ Generando Snapshot...</span>';
      try {
        const res = await API.post('/settings/auto-backup-now', {});
        showToast(res.message, 'success');
        updateSelfBackupStatus();
      } catch (err) {
        showToast(`Error en auto-respaldo: ${err.message}`, 'error');
      } finally {
        btnTriggerSelfBackup.disabled = false;
        btnTriggerSelfBackup.innerHTML = originalText;
      }
    });
  }

  async function updateSelfBackupStatus() {
    try {
      const status = await API.get('/settings/self-backup-status');
      if (status && status.lastRun) {
        const dateStr = new Date(status.lastRun).toLocaleString();
        const el = document.getElementById('self-backup-status-text');
        if (el) {
          el.innerHTML = `Último snapshot: <strong>${dateStr}</strong> (${status.filename} - ${status.fileSizeMB} MB)${status.replicatedCloud ? ' <span style="color: var(--accent-green);">☁️ Replicado en Cloud</span>' : ''}`;
        }
      }
    } catch {}
  }

  // =========================================================================
  // ARRANCAR
  // =========================================================================
  checkAuthStatus();
});
