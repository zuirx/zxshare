# zuirx share

> Compartilhamento de tela em tempo real via **WebRTC + Flask + Socket.IO**

[![Python](https://img.shields.io/badge/Python-3.10%2B-blue)](https://python.org)
[![Flask](https://img.shields.io/badge/Flask-3.0-green)](https://flask.palletsprojects.com)
[![WebRTC](https://img.shields.io/badge/WebRTC-P2P-orange)](https://webrtc.org)

---

## Índice

- [Como funciona](#como-funciona)
- [Instalação](#instalação)
- [Execução local](#execução-local)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Produção](#produção)

---

## Como funciona

### Arquitetura geral

```
Browser A (compartilhador)        Servidor Flask        Browser B (espectador)
──────────────────────────   ──────────────────────   ──────────────────────────
getDisplayMedia()            Cria sessão (ID único)   GET /view/<session_id>
Socket.IO connect()    ───►  Socket.IO signaling  ◄─── Socket.IO connect()
createOffer()          ───►  relay offer          ───► setRemoteDescription()
                             relay answer         ◄─── createAnswer()
ICE candidates         ───►  relay ICE candidates ───► addIceCandidate()

        ◄─────────────── WebRTC P2P (vídeo direto) ──────────────────►
                   (o servidor NUNCA vê o conteúdo do vídeo)
```

### Etapas do fluxo

| Etapa | Quem executa | O que acontece |
|-------|-------------|----------------|
| 1 | Navegador (compartilhador) | `getDisplayMedia()` captura a tela localmente |
| 2 | Flask | `POST /api/create-session` gera um ID aleatório de 32 hex chars |
| 3 | Socket.IO | Compartilhador registra-se como sharer da sessão |
| 4 | Navegador (espectador) | Acessa `/view/<id>`, emite `join_as_viewer` |
| 5 | Socket.IO | Servidor notifica sharer: "novo espectador quer stream" |
| 6 | Navegador (compartilhador) | Cria `RTCPeerConnection`, gera SDP offer |
| 7 | Socket.IO | Servidor relay: offer → espectador |
| 8 | Navegador (espectador) | Cria answer, envia de volta via Socket.IO |
| 9 | Socket.IO | Servidor relay: answer → compartilhador |
| 10 | Ambos | Trocam ICE candidates via Socket.IO |
| 11 | WebRTC | Conexão P2P estabelecida — vídeo flui diretamente |

### Segurança de sessão

- IDs de sessão: `secrets.token_hex(16)` → 128 bits de entropia → ~3.4 × 10³⁸ possibilidades
- O servidor limpa sessões com mais de 1 hora automaticamente
- Nenhum dado de vídeo passa pelo servidor

---

## Instalação

### Pré-requisitos

- Python 3.10+
- pip

### Passos

```bash
# 1. Clone ou baixe o projeto
cd zxsharer

# 2. (Recomendado) Crie um ambiente virtual
python -m venv venv

# Windows
venv\Scripts\activate

# macOS / Linux
source venv/bin/activate

# 3. Instale as dependências
pip install -r requirements.txt
```

---

## Execução local

```bash
python app.py
```

Abra `http://localhost:5000` no navegador.

> **Nota:** `getDisplayMedia()` requer HTTPS em produção. Em localhost, os navegadores permitem HTTP por exceção de origem segura.

### Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` | `5000` | Porta do servidor |
| `FLASK_DEBUG` | `1` | `0` para desligar o modo debug |

---

## Estrutura do projeto

```
zxsharer/
├── app.py                  # Backend Flask: rotas HTTP + Socket.IO signaling
├── requirements.txt        # Dependências Python
├── README.md
├── templates/
│   ├── base.html           # Layout base compartilhado (fontes, meta, CSS)
│   ├── index.html          # Página inicial — botão "Compartilhar"
│   ├── share.html          # Página do compartilhador — preview + link
│   └── view.html           # Página do espectador — player de vídeo
└── static/
    ├── css/
    │   └── styles.css      # Design system: dark theme, glassmorphism, animações
    └── js/
        ├── share.js        # Lógica do compartilhador: getDisplayMedia + WebRTC offer
        └── view.js         # Lógica do espectador: WebRTC answer + video render
```

### Responsabilidades por arquivo

| Arquivo | Responsabilidade |
|---------|-----------------|
| `app.py` | Servir páginas, criar sessões, relay de sinais WebRTC via Socket.IO |
| `share.js` | `getDisplayMedia`, criar `RTCPeerConnection` por espectador, enviar offers |
| `view.js` | Receber offer, criar answer, anexar stream ao `<video>` |
| `styles.css` | Toda a aparência visual — sem frameworks CSS |

---

## Produção

Para colocar em produção você precisará de:

### 1. HTTPS obrigatório

`getDisplayMedia()` requer HTTPS. Use um certificado SSL válido (Let's Encrypt é gratuito):

```bash
# Exemplo com certbot + nginx
certbot --nginx -d seudominio.com
```

### 2. Servidor WSGI + nginx

Instale `gunicorn` com suporte a eventlet:

```bash
pip install gunicorn eventlet
gunicorn --worker-class eventlet -w 1 app:app --bind 0.0.0.0:8000
```

Exemplo de configuração nginx (`/etc/nginx/sites-available/zxsharer`):

```nginx
server {
    listen 443 ssl;
    server_name seudominio.com;

    ssl_certificate     /etc/letsencrypt/live/seudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/seudominio.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 3. Servidor TURN (para NAT traversal)

Em redes corporativas ou conexões simétricas, o WebRTC pode precisar de um servidor TURN:

- **coturn** (open-source, auto-hospedado)
- **Twilio Network Traversal Service** (gratuito até certo limite)
- **Metered.ca TURN** (plano gratuito disponível)

Adicione as credenciais em `RTC_CONFIG` em `share.js` e `view.js`:

```js
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:seu-turn-server.com:3478",
      username: "usuario",
      credential: "senha",
    },
  ],
};
```

### 4. Escalabilidade

A arquitetura atual usa **Mesh P2P** (1 conexão por espectador no compartilhador). Para suportar dezenas de espectadores simultâneos, considere uma arquitetura **SFU** com mediasoup ou Janus Gateway — mas isso está além do escopo deste projeto.

---

## Licença

MIT
