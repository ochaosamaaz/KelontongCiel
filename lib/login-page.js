/**
 * Returns the login page HTML string.
 * Extracted from server.js to reduce monolith size.
 */
function getLoginPageHTML() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>License Validation - Login</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            /* Light Mode Colors */
            --bg-primary: #f9f9f9;
            --bg-secondary: #ffffff;
            --text-primary: #1e1e1e;
            --text-secondary: #6b7280;
            --border-color: #000000;
            --input-bg: #ffffff;
            --input-border: #e5e7eb;
            --accent-color: #f0c419;
            --accent-hover: #dbb015;
            --shadow-color: #000000;
            --error-bg: #fee2e2;
            --error-text: #dc2626;
        }
        
        [data-theme="dark"] {
            /* Dark Mode Colors */
            --bg-primary: #0a0a0a;
            --bg-secondary: #1a1a1a;
            --text-primary: #ffffff;
            --text-secondary: #9ca3af;
            --border-color: #ffffff;
            --input-bg: #2a2a2a;
            --input-border: #3a3a3a;
            --accent-color: #f0c419;
            --accent-hover: #dbb015;
            --shadow-color: #ffffff;
            --error-bg: #450a0a;
            --error-text: #fca5a5;
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Outfit', sans-serif;
            background: var(--bg-primary);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
            transition: background 0.3s ease;
        }
        
        .login-container {
            background: var(--bg-secondary);
            border: 4px solid var(--border-color);
            border-radius: 12px;
            box-shadow: 8px 8px 0px 0px var(--shadow-color);
            padding: 48px;
            width: 100%;
            max-width: 440px;
            animation: slideIn 0.4s ease-out;
            transition: all 0.3s ease;
        }
        
        @keyframes slideIn {
            from { opacity: 0; transform: translateY(-20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .login-header {
            text-align: center;
            margin-bottom: 36px;
        }
        
        .login-header .icon {
            width: 72px;
            height: 72px;
            background: var(--accent-color);
            border: 3px solid var(--border-color);
            border-radius: 12px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 36px;
            margin-bottom: 20px;
            box-shadow: 4px 4px 0px 0px var(--shadow-color);
        }
        
        .login-header h1 {
            color: var(--text-primary);
            font-size: 28px;
            margin-bottom: 8px;
            font-weight: 800;
            letter-spacing: -0.5px;
        }
        
        .login-header p {
            color: var(--text-secondary);
            font-size: 15px;
            font-weight: 500;
        }
        
        .form-group {
            margin-bottom: 24px;
        }
        
        .form-group label {
            display: block;
            color: var(--text-primary);
            font-weight: 700;
            margin-bottom: 10px;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .form-group input {
            width: 100%;
            padding: 14px 16px;
            border: 3px solid var(--input-border);
            border-radius: 8px;
            font-size: 15px;
            font-family: 'Outfit', sans-serif;
            font-weight: 500;
            color: var(--text-primary);
            background: var(--input-bg);
            transition: all 0.2s ease;
        }
        
        .form-group input:focus {
            outline: none;
            border-color: var(--accent-color);
            box-shadow: 0 0 0 4px rgba(240, 196, 25, 0.15);
        }
        
        .btn-login {
            width: 100%;
            padding: 16px;
            background: var(--accent-color);
            color: #000000;
            border: 3px solid var(--border-color);
            border-radius: 8px;
            font-size: 16px;
            font-weight: 800;
            cursor: pointer;
            transition: all 0.15s ease;
            font-family: 'Outfit', sans-serif;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            box-shadow: 4px 4px 0px 0px var(--shadow-color);
        }
        
        .btn-login:hover {
            background: var(--accent-hover);
            transform: translate(2px, 2px);
            box-shadow: 2px 2px 0px 0px var(--shadow-color);
        }
        
        .btn-login:active {
            transform: translate(4px, 4px);
            box-shadow: 0px 0px 0px 0px var(--shadow-color);
        }
        
        .btn-login:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        
        .error-message {
            background: var(--error-bg);
            color: var(--error-text);
            padding: 14px 16px;
            border-radius: 8px;
            margin-bottom: 24px;
            display: none;
            font-size: 14px;
            font-weight: 600;
            border: 2px solid var(--error-text);
        }
        
        .error-message.show {
            display: block;
            animation: shake 0.4s ease;
        }
        
        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-8px); }
            75% { transform: translateX(8px); }
        }
        
        .loading {
            display: inline-block;
            width: 18px;
            height: 18px;
            border: 3px solid rgba(0,0,0,.2);
            border-radius: 50%;
            border-top-color: #000000;
            animation: spin 0.8s linear infinite;
            margin-right: 8px;
        }
        
        @keyframes spin { to { transform: rotate(360deg); } }
        
        .footer-text {
            text-align: center;
            margin-top: 24px;
            color: var(--text-secondary);
            font-size: 13px;
            font-weight: 500;
        }

        /* Theme Toggle Button */
        .theme-toggle {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 50px;
            height: 50px;
            background: var(--bg-secondary);
            border: 3px solid var(--border-color);
            border-radius: 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            box-shadow: 4px 4px 0px 0px var(--shadow-color);
            transition: all 0.15s ease;
            z-index: 1000;
        }
        .theme-toggle:hover {
            transform: translate(2px, 2px);
            box-shadow: 2px 2px 0px 0px var(--shadow-color);
        }
        .theme-toggle:active {
            transform: translate(4px, 4px);
            box-shadow: 0px 0px 0px 0px var(--shadow-color);
        }
    </style>
</head>
<body>
    <div id="themeToggle" class="theme-toggle" title="Toggle Dark Mode">
        <span id="themeIcon">\u2600\uFE0F</span>
    </div>

    <div class="login-container">
        <div class="login-header">
            <div class="icon">\uD83D\uDD10</div>
            <h1>License Validation</h1>
            <p>Enter your license key to continue</p>
        </div>
        
        <div id="errorMessage" class="error-message"></div>
        
        <form id="loginForm">
            <div class="form-group">
                <label for="licenseKey">License Key</label>
                <input 
                    type="text" 
                    id="licenseKey" 
                    name="licenseKey" 
                    placeholder="Enter your license key"
                    required
                    autocomplete="off"
                >
            </div>
            
            <button type="submit" class="btn-login" id="loginBtn">
                Login
            </button>
        </form>
        
        <div class="footer-text">
            Powered by Whitelist Bot API
        </div>
    </div>
    
    <script>
        // --- Theme Toggle Logic ---
        const themeToggle = document.getElementById('themeToggle');
        const themeIcon = document.getElementById('themeIcon');
        
        // Load Saved Theme
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        themeIcon.textContent = savedTheme === 'dark' ? '\uD83C\uDF19' : '\u2600\uFE0F';

        themeToggle.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            themeIcon.textContent = newTheme === 'dark' ? '\uD83C\uDF19' : '\u2600\uFE0F';
        });

        // --- Login Logic ---
        const form = document.getElementById('loginForm');
        const errorMessage = document.getElementById('errorMessage');
        const loginBtn = document.getElementById('loginBtn');
        const licenseInput = document.getElementById('licenseKey');
        
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const licenseKey = licenseInput.value.trim();
            
            if (!licenseKey) {
                showError('Please enter a license key');
                return;
            }
            
            // Show loading state
            loginBtn.disabled = true;
            loginBtn.innerHTML = '<span class="loading"></span>Validating...';
            errorMessage.classList.remove('show');
            
            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ licenseKey })
                });
                
                const data = await response.json();
                
                if (response.ok && data.success) {
                    // Login successful
                    loginBtn.innerHTML = '\u2713 Success! Redirecting...';
                    loginBtn.style.background = '#10b981';
                    loginBtn.style.borderColor = '#000000';
                    setTimeout(() => {
                        window.location.href = '/';
                    }, 500);
                } else {
                    // Login failed
                    showError(data.error || 'Invalid license key');
                    loginBtn.disabled = false;
                    loginBtn.innerHTML = 'Login';
                }
            } catch (error) {
                showError('Connection error. Please try again.');
                loginBtn.disabled = false;
                loginBtn.innerHTML = 'Login';
            }
        });
        
        function showError(message) {
            errorMessage.textContent = message;
            errorMessage.classList.add('show');
        }
        
        // Auto-focus on license input
        licenseInput.focus();
    </script>
</body>
</html>`;
}

export { getLoginPageHTML };
