#!/bin/bash

set -e

echo "╔══════════════════════════════════════╗"
echo "║   GenAI Platform — Kurulum           ║"
echo "╚══════════════════════════════════════╝"
echo ""

if ! command -v node &> /dev/null; then
    echo "❌ Node.js bulunamadı. Lütfen Node.js 20+ kurun."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js 20+ gerekli. Mevcut: $(node -v)"
    exit 1
fi
echo "✅ Node.js: $(node -v)"

if ! command -v pnpm &> /dev/null; then
    echo "📦 pnpm kuruluyor..."
    npm install -g pnpm
fi
echo "✅ pnpm: $(pnpm -v)"

echo ""
echo "📦 Bağımlılıklar kuruluyor..."
pnpm install

if [ ! -f .env ]; then
    echo ""
    echo "⚠️  .env dosyası bulunamadı. .env.example'dan kopyalanıyor..."
    cp .env.example .env
    echo "📝 .env dosyasını düzenleyip OPENROUTER_API_KEY değerini girin."
fi

echo ""
echo "✅ Kurulum tamamlandı!"
echo ""
echo "Çalıştırmak için:"
echo "  npx tsx packages/agents/src/code-review/run.ts \"AgentLoop.ts dosyasını incele\""
