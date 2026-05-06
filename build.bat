@echo off

@echo [1m[7mcd /d "%~dp0"[0m
cd /d "%~dp0"
@if %errorlevel% neq 0 echo [41m --^> failed(%errorlevel%)[0m & exit /b %errorlevel%

@echo [1m[7mnpm ci --ignore-scripts[0m
@call npm ci --ignore-scripts
@if %errorlevel% neq 0 echo [41m --^> failed(%errorlevel%)[0m & exit /b %errorlevel%

@echo [1m[7mnpm audit --audit-level=moderate[0m
@call npm audit --audit-level=moderate
@if %errorlevel% neq 0 echo [41m --^> failed(%errorlevel%)[0m & exit /b %errorlevel%

@echo [1m[7mnpm run check[0m
@call npm run check
@if %errorlevel% neq 0 echo [41m --^> failed(%errorlevel%)[0m & exit /b %errorlevel%

@echo [1m[7mnpm run build[0m
@call npm run build
@if %errorlevel% neq 0 echo [41m --^> failed(%errorlevel%)[0m & exit /b %errorlevel%

@echo [1m[7mnpm run package[0m
@call npm run package
@if %errorlevel% neq 0 echo [41m --^> failed(%errorlevel%)[0m & exit /b %errorlevel%

@echo [1m[7mnpx vsce ls --tree[0m
@call npx vsce ls --tree
@if %errorlevel% neq 0 echo [41m --^> failed(%errorlevel%)[0m & exit /b %errorlevel%

@echo [1m[7mmove /Y *.vsix .\build\*[0m
move /Y *.vsix .\build\
@if %errorlevel% neq 0 echo [41m --^> failed(%errorlevel%)[0m & exit /b %errorlevel%

@echo [42m all done![0m

@echo on