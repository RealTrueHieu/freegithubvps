// Deployment modes — tách từ src/worker.js (FIX: đã xóa presetNgrokToken hardcode bị lộ).
// Token cho mode ngrok_fast giờ chỉ lấy từ KV `config:ngrok_fast_token` do admin nhập.
import { WF_VNC_B64, WF_BORE_B64, WF_NGROK_B64 } from './workflows.js';

export const MODES = {
  vnc: {
    repoName: 'vps-novnc',
    workflowFile: 'rdp.yml',
    outputFile: 'remote-link.txt',
    defaultUsername: '(noVNC)',
    defaultPassword: 'hieudz',
    needsNgrokToken: false,
    workflowB64: WF_VNC_B64,
  },
  bore: {
    repoName: 'vps-bore',
    workflowFile: 'rdp.yml',
    outputFile: 'rdp_info.txt',
    defaultUsername: 'admin',
    defaultPassword: 'WindowsRDP2026@',
    needsNgrokToken: false,
    workflowB64: WF_BORE_B64,
  },
  ngrok: {
    repoName: 'vps-ngrok',
    workflowFile: 'rdp.yml',
    outputFile: 'rdp_info.txt',
    defaultUsername: 'DucthengTechDz',
    defaultPassword: 'W1nd0ws-P4ssw0rd-2025!',
    needsNgrokToken: true,
    workflowB64: WF_NGROK_B64,
  },
  ngrok_fast: {
    repoName: 'vps-ngrok',
    workflowFile: 'rdp.yml',
    outputFile: 'rdp_info.txt',
    defaultUsername: 'DucthengTechDz',
    defaultPassword: 'W1nd0ws-P4ssw0rd-2025!',
    needsNgrokToken: false,
    workflowB64: WF_NGROK_B64,
  },
};

export const DEFAULT_MODE = 'vnc';

export function getMode(m) { return MODES[m] ? m : DEFAULT_MODE; }
