#!/usr/bin/env sh

while [ "$#" -gt 0 ]; do
    case "$1" in
        --propath)
            PROPATH=$2
            shift 2
            ;;
        --workdir)
            WORKDIR=$2
            shift 2
            ;;
        --testfile)
            TESTFILE=$2
            shift 2
            ;;
        --dlc)
            DLC=$2
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

echo "Start ABLUnit testing.."

ATTR_ABLUNIT_EVENT_FILE="$WORKDIR/.ablunitrunner/ablunit_event.log"
rm -f "$ATTR_ABLUNIT_EVENT_FILE"

cd "$WORKDIR" || exit 1
"$DLC/bin/_progres" -b -p ABLUnitCore.p -pf .ablunitrunner/dbconn.pf -pf .ablunitrunner/extra.pf -param "$TESTFILE -outputLocation .ablunitrunner" -baseADE "$PROPATH"

echo "Done ABLUnit testing."

