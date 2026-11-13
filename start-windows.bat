@echo off
setlocal
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo Starting Human Nature Stories Studio...
call npm start
