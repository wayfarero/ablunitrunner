
set CURRDIR=%CD%

mkdir build

call vsce package 

cd %CURRDIR%
move *.vsix build

