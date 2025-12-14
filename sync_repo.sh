#!/bin/bash
cd /Users/Aaron/Documents/GitHub/Runalyze-Dashboard
git pull --rebase
echo "Repo synced at $(date)" >> /tmp/repo_sync.log