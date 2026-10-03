#!/usr/bin/env bash
# Generic, adaptable OpenRig launcher — pick an existing project or create a
# new one. See .rig-launcher/launcher.py in the openrig repo for the actual
# logic; this is just the double-clickable entry point.
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
python3 "/Users/bakari/Documents/GitHub/openrig/.rig-launcher/launcher.py"
