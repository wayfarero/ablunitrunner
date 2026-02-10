
set CURRDIR=%CD%

mkdir ..\build

cd ..
call vsce ls
call vsce package 

cd %CURRDIR%
move ..\*.vsix ..\build

