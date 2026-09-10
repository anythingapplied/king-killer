#!/usr/bin/env bash
echo "Cleaning up ports..."
fuser -k 3000/tcp 2>/dev/null
fuser -k 5173/tcp 2>/dev/null
sleep 2

echo "Starting Backend..."
cd king-killer-api
nohup nix shell nixpkgs#gcc -c cargo run > ../backend.log 2>&1 &
cd ..

echo "Starting Frontend..."
cd frontend
nohup nix shell nixpkgs#nodejs_20 -c npm run dev -- --port 5173 --host 0.0.0.0 > ../frontend.log 2>&1 &
cd ..

echo "Servers initiated. Logs at backend.log and frontend.log"
