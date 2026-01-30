@echo off
set  REPO=C:\github\dagmarcom-backend
call %REPO%\venv\Scripts\activate.bat
pushd %REPO%
npm run dev
popd
