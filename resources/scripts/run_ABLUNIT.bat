@echo off
   
:GETOPTS
 if /I "%~1"=="--propath" set PROPATH=%~2& shift
 if /I "%~1"=="--workdir" set WORKDIR=%~2& shift
 if /I "%~1"=="--testfile" set TESTFILE=%~2& shift
 if /I "%~1"=="--dlc" set DLC=%~2& shift
 shift
if not "%~1"=="" goto GETOPTS

echo Start ABLUnit testing

set ATTR_ABLUNIT_EVENT_FILE=%WORKDIR%\.ablunitrunner\ablunit_event.log
if exist "%ATTR_ABLUNIT_EVENT_FILE%" del /q "%ATTR_ABLUNIT_EVENT_FILE%"

cd %WORKDIR%
%DLC%\bin\_progres -b -p ABLUnitCore.p -pf .ablunitrunner/dbconn.pf -pf .ablunitrunner/extra.pf -param "%TESTFILE% -outputLocation .ablunitrunner" -baseADE "%PROPATH%"


echo Done ABLUnit testing