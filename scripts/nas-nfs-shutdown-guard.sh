#!/bin/sh
set -eu

TARGET_A="/share/CACHEDEV1_DATA/mnt/ts212_500a"
TARGET_B="/share/CACHEDEV1_DATA/mnt/ts212_500b"

on_stop() {
  if nsenter -t 1 -m sh -c '[ -f /var/qfunc/rcK ]'; then
    echo "QTS shutdown detected; detaching TS-212 NFS mounts before network teardown"
    nsenter -t 1 -m sh -c "umount -f -l '$TARGET_A' 2>/dev/null || true; umount -f -l '$TARGET_B' 2>/dev/null || true"
  else
    echo "Container stop without QTS shutdown; leaving TS-212 NFS mounts attached"
  fi
  exit 0
}

trap on_stop TERM INT
echo "NFS shutdown guard ready"
while :; do
  sleep 3600 &
  wait $! || true
done
