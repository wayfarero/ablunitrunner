
set CURRDIR=%CD%

mkdir ..\build

cd ..

@node -e "const fs = require('fs'); const sh = 'resources/scripts/run_ABLUNIT.sh'; const shRaw = fs.readFileSync(sh, 'utf8'); const shLf = shRaw.split('\r\n').join('\n').split('\r').join('\n'); if (shLf === shRaw) {} else { fs.writeFileSync(sh, shLf, 'utf8'); } if (fs.readFileSync(sh, 'utf8').includes('\r')) { console.error('ERROR: CR found in ' + sh); process.exit(1); } const bat = 'resources/scripts/run_ABLUNIT.bat'; const batRaw = fs.readFileSync(bat, 'utf8'); const batCrlf = batRaw.split('\r\n').join('\n').split('\r').join('\n').split('\n').join('\r\n'); if (batCrlf === batRaw) {} else { fs.writeFileSync(bat, batCrlf, 'utf8'); } const batCheck = fs.readFileSync(bat, 'utf8').split('\r\n').join(''); if (batCheck.includes('\n')) { console.error('ERROR: Bare LF found in ' + bat); process.exit(1); } if (batCheck.includes('\r')) { console.error('ERROR: Bare CR found in ' + bat); process.exit(1); }"
@if errorlevel 1 (
    @cd %CURRDIR%
    @exit /b 1
)
@echo Normalized runner script line endings.

call vsce ls
call vsce package 

cd %CURRDIR%
move ..\*.vsix ..\build

